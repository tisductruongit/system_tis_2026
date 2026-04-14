# backend/chat/consumers.py

import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from api.models import ConsultationRequest, ChatMessage, User
from django.utils import timezone

class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        # Lấy consultation_id từ URL (ws://.../ws/chat/<id>/)
        self.consultation_id = self.scope['url_route']['kwargs']['consultation_id']
        self.room_group_name = f'chat_{self.consultation_id}'

        # Tham gia vào room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )

        await self.accept()

    async def disconnect(self, close_code):
        # Rời khỏi room group
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    # Nhận dữ liệu từ WebSocket (Client gửi lên)
    async def receive(self, text_data):
        data = json.loads(text_data)
        
        # 1. Kiểm tra loại tin nhắn (Loại bỏ lỗi KeyError khi không có khóa 'message')
        msg_type = data.get('type')

        # 2. Xử lý các thông báo trạng thái (typing/stop_typing)
        if msg_type in ['typing', 'stop_typing']:
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'chat_control', # Gọi hàm chat_control bên dưới
                    'msg_type': msg_type,
                    'sender_id': data.get('sender_id')
                }
            )
            return

        # 3. Xử lý tin nhắn văn bản thông thường
        message = data.get('message')
        if not message:
            return

        sender_id = data.get('sender_id')
        is_staff = data.get('is_staff', False)

        # Lưu tin nhắn vào Database
        saved_message = await self.save_message(message, sender_id, is_staff)

        # Gửi tin nhắn đến Group để tất cả client trong phòng nhận được
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'chat_message',
                'message': saved_message['message'],
                'sender_name': saved_message['sender_name'],
                'is_staff_reply': saved_message['is_staff_reply'],
                'created_at': saved_message['created_at'],
                'avatar': saved_message['avatar']
            }
        )

    # Xử lý sự kiện gửi tin nhắn văn bản xuống Client
    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            'message': event['message'],
            'sender_name': event['sender_name'],
            'is_staff_reply': event['is_staff_reply'],
            'created_at': event['created_at'],
            'avatar': event['avatar']
        }))

    # Xử lý sự kiện gửi trạng thái (typing/stop_typing) xuống Client
    async def chat_control(self, event):
        await self.send(text_data=json.dumps({
            'type': event['msg_type'],
            'sender_id': event['sender_id']
        }))

    @database_sync_to_async
    def save_message(self, message, sender_id, is_staff):
        try:
            consultation = ConsultationRequest.objects.get(id=self.consultation_id)
        except ConsultationRequest.DoesNotExist:
            return None

        sender = None
        if sender_id:
            try:
                sender = User.objects.get(id=sender_id)
            except User.DoesNotExist:
                pass

        # Tạo bản ghi tin nhắn mới
        msg = ChatMessage.objects.create(
            consultation=consultation,
            sender=sender,
            message=message,
            is_staff_reply=is_staff
        )
        
        # Chuẩn bị dữ liệu trả về
        avatar_url = None
        if sender and sender.avatar:
            avatar_url = sender.avatar.url

        return {
            'message': msg.message,
            'sender_name': f"{sender.last_name} {sender.first_name}" if sender else "Khách hàng",
            'is_staff_reply': msg.is_staff_reply,
            'created_at': msg.created_at.strftime('%H:%M'),
            'avatar': avatar_url
        }
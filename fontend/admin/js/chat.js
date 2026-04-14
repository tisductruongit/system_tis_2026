/**
 * fontend/admin/js/chat.js
 * Chức năng: WebSocket Chat Client cho Admin
 */

let currentConsultationId = null;
let chatSocket = null;
let currentUser = null;
let reconnectInterval = null; // Biến để quản lý thử lại kết nối

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Lấy thông tin Admin đang đăng nhập
    try {
        currentUser = await fetchAPI('/users/me/');
        if (!['admin', 'super_admin', 'staff'].includes(currentUser.role) && !currentUser.is_superuser) {
            alert("Không có quyền truy cập");
            window.location.href = 'index.html';
            return;
        }
    } catch (e) {
        window.location.href = '../login.html';
        return;
    }

    // 2. Lấy ID từ URL (nếu bấm từ trang consultations chuyển sang)
    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get('id');

    // 3. Tải danh sách
    loadConversations(id);
    
    // 4. Bắt sự kiện tìm kiếm trên sidebar
    setupSearchListener();
});

// Setup search functionality
function setupSearchListener() {
    const searchInput = document.querySelector('.msgr-search-container input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            filterConversations(e.target.value.toLowerCase());
        });
    }
}

function filterConversations(query) {
    const items = document.querySelectorAll('.msgr-item');
    items.forEach(item => {
        const name = item.querySelector('.customer-name');
        if (name && name.textContent.toLowerCase().includes(query)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

// --- 1. QUẢN LÝ DANH SÁCH HỘI THOẠI ---
async function loadConversations(activeId) {
    const listEl = document.getElementById('conv-list');
    try {
        // Lấy tất cả yêu cầu tư vấn
        // Backend nên có filter chỉ lấy những cái status='processed' hoặc 'new'
        const data = await fetchAPI('/consultations/'); 
        
        if (!data || data.length === 0) {
            listEl.innerHTML = '<div class="text-center text-muted mt-5">Chưa có yêu cầu nào.</div>';
            return;
        }

        listEl.innerHTML = data.map(item => {
            const isActive = item.id == activeId ? 'active' : '';
            // Lấy tin nhắn cuối (Backend cần trả về last_message trong serializer)
            const lastMsg = item.last_message ? item.last_message.message : 'Chưa có tin nhắn';
            const time = item.last_message ? item.last_message.time : new Date(item.created_at).toLocaleDateString('vi-VN');
            const avatarLetter = item.customer_name.charAt(0).toUpperCase();
            const relativeTime = getRelativeTime(item.last_message?.created_at || item.created_at);
            
            return `
            <div class="msgr-item ${isActive}" onclick="openChat(${item.id}, '${item.customer_name}')" id="conv-item-${item.id}" data-conversation-id="${item.id}">
                <div class="msgr-avatar">${avatarLetter}</div>
                <div class="flex-grow-1 overflow-hidden">
                    <div class="d-flex justify-content-between align-items-center">
                        <span class="fw-bold text-dark text-truncate customer-name" style="max-width: 140px;">${item.customer_name}</span>
                        <small class="text-muted" style="font-size:0.75rem" title="${new Date(item.last_message?.created_at || item.created_at).toLocaleString('vi-VN')}">${relativeTime}</small>
                    </div>
                    <div class="text-muted small text-truncate" id="last-msg-${item.id}">${lastMsg}</div>
                </div>
            </div>`;
        }).join('');

        // Nếu có ID active thì mở chat luôn
        if (activeId) {
            const activeItem = data.find(i => i.id == activeId);
            if(activeItem) openChat(activeId, activeItem.customer_name);
        }

    } catch (e) { 
        console.error("Lỗi tải hội thoại", e);
        listEl.innerHTML = '<div class="text-danger text-center mt-3">Lỗi tải dữ liệu</div>';
    }
}

// --- 2. MỞ CHAT VÀ KẾT NỐI WEBSOCKET ---
async function openChat(id, name) {
    if (currentConsultationId === id) return; // Đang chat với người này rồi thì thôi

    // Đóng socket cũ nếu có
    if (chatSocket) {
        chatSocket.close();
        clearInterval(reconnectInterval);
    }
    
    currentConsultationId = id;

    // UI Update Header
    document.getElementById('header-name').innerText = name;
    document.getElementById('header-avatar').innerText = name.charAt(0).toUpperCase();
    updateStatus('connecting'); // Cập nhật trạng thái "Đang kết nối..."
    document.getElementById('input-area').style.display = 'flex'; // Hiện khung nhập
    
    // UI Update Active List
    document.querySelectorAll('.msgr-item').forEach(el => el.classList.remove('active'));
    const activeItem = document.getElementById(`conv-item-${id}`);
    if(activeItem) activeItem.classList.add('active');

    // Load Lịch sử Chat (HTTP API)
    await fetchHistory(id);

    // Kết nối WebSocket
    connectWebSocket(id);
}

// Hàm kết nối WebSocket (Có tự động kết nối lại)
function connectWebSocket(id) {
    // Tự động chọn ws:// hoặc wss:// dựa trên giao thức web hiện tại
    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    
    // [QUAN TRỌNG] Port Backend thường là 8000. Nếu deploy server thật thì bỏ :8000 đi
    // Thay 127.0.0.1 bằng domain server nếu deploy
    const wsUrl = `ws://127.0.0.1:8000/ws/chat/${id}/`; 

    console.log("Connecting to:", wsUrl);
    chatSocket = new WebSocket(wsUrl);

    // KHI KẾT NỐI THÀNH CÔNG
    chatSocket.onopen = function(e) {
        console.log("WebSocket Connected!");
        updateStatus('online');
        clearInterval(reconnectInterval); // Ngừng thử lại
    };

    // KHI NHẬN TIN NHẮN MỚI
    chatSocket.onmessage = function(e) {
        const data = JSON.parse(e.data);
        
        // Nếu là thông báo 'typing', hiển thị indicator
        if (data.type === 'typing') {
            showTypingIndicator();
        } else if (data.type === 'stop_typing') {
            hideTypingIndicator();
        } else {
            hideTypingIndicator(); // Ẩn khi có tin nhắn mới
            appendMessage(data); // Vẽ tin nhắn lên màn hình
            
            // Cập nhật tin nhắn cuối ở sidebar trái
            const lastMsgEl = document.getElementById(`last-msg-${id}`);
            if(lastMsgEl) lastMsgEl.innerText = data.message;
        }
    };

    // KHI MẤT KẾT NỐI (Đóng hoặc Lỗi)
    chatSocket.onclose = function(e) {
        console.warn("WebSocket Closed. Reconnecting in 3s...", e);
        updateStatus('offline');
        
        // Thử kết nối lại sau 3 giây (nếu vẫn đang ở chat room này)
        if (currentConsultationId === id) {
            clearInterval(reconnectInterval);
            reconnectInterval = setTimeout(() => connectWebSocket(id), 3000);
        }
    };

    chatSocket.onerror = function(err) {
        console.error("WebSocket Error:", err);
        chatSocket.close(); // Gọi close để kích hoạt onclose và thử lại
    };
}

// Helper cập nhật trạng thái online/offline
function updateStatus(state) {
    const el = document.getElementById('header-status');
    if (state === 'online') {
        el.innerHTML = '<i class="fas fa-circle x-small text-success"></i> Trực tuyến';
    } else if (state === 'connecting') {
        el.innerHTML = '<i class="fas fa-circle x-small text-warning"></i> Đang kết nối...';
    } else {
        el.innerHTML = '<i class="fas fa-circle x-small text-secondary"></i> Mất kết nối';
    }
}

// --- 3. XỬ LÝ HIỂN THỊ TIN NHẮN ---
async function fetchHistory(id) {
    const box = document.getElementById('message-box');
    box.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div></div>';
    
    try {
        // Gọi API lấy lịch sử (đã tạo ở Backend bước trước)
        const msgs = await fetchAPI(`/consultations/${id}/messages/`);
        
        if(msgs.length === 0) {
            box.innerHTML = '<div class="text-center text-muted mt-5"><p>Bắt đầu hỗ trợ khách hàng ngay.</p></div>';
            return;
        }
        
        box.innerHTML = ''; // Xóa loading
        msgs.forEach(m => {
            // Map dữ liệu từ API sang format chung
            const formattedMsg = {
                message: m.message,
                is_staff_reply: m.is_staff_reply,
                created_at: new Date(m.created_at).toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit'}),
                sender_name: m.sender_name,
                avatar: m.avatar
            };
            appendMessage(formattedMsg);
        });
        
        // Cuộn xuống đáy sau khi load xong
        scrollToBottom();

    } catch (e) { 
        console.error(e);
        box.innerHTML = '<div class="text-danger text-center">Không thể tải lịch sử chat.</div>';
    }
}

function appendMessage(data) {
    const box = document.getElementById('message-box');
    const isMe = data.is_staff_reply; // Admin/Staff luôn là 'Me' (bên phải)
    
    const alignClass = isMe ? 'msg-right' : 'msg-left';
    const justifyClass = isMe ? 'justify-content-end' : 'justify-content-start';
    
    // Avatar cho tin nhắn khách (bên trái)
    const avatarHtml = !isMe 
        ? `<div class="msgr-avatar bg-light text-dark me-2" style="width:28px;height:28px;font-size:0.8rem;font-weight:bold">${data.sender_name?.charAt(0).toUpperCase() || 'K'}</div>` 
        : '';
    
    // Xác định nếu cần hiển thị tên (grouping)
    const lastMessage = box.lastElementChild;
    const shouldShowName = !lastMessage || lastMessage.dataset.sender !== data.sender_name || !data.is_staff_reply === lastMessage.dataset.isStaff;
    
    const nameHtml = shouldShowName && !isMe ? `<small class="text-muted text-truncate ms-2" style="font-size:0.7rem;width:28px;text-align:center">${data.sender_name || 'Khách'}</small>` : '';
    
    // Status check marks (✓✓ for seen, ✓ for sent)
    const statusHtml = isMe ? `<small class="text-success ms-1" style="font-size:0.8rem;" title="Đã gửi">✓✓</small>` : '';

    const html = `
    <div class="d-flex w-100 ${justifyClass} mb-2 animate-fade-in" data-sender="${data.sender_name}" data-isStaff="${isMe}">
         ${avatarHtml}
         <div class="d-flex flex-column align-items-${isMe ? 'end' : 'start'}">
            ${nameHtml}
            <div class="msg-bubble ${alignClass}" title="${data.sender_name} • ${data.created_at}">
                ${data.message}${statusHtml}
            </div>
            <small class="text-muted mt-1" style="font-size:0.7rem">${data.created_at}</small>
         </div>
    </div>`;

    // Nếu đang hiện thông báo trống thì xóa đi
    const emptyState = box.querySelector('.msgr-empty');
    if(emptyState) emptyState.remove();
    if(box.querySelector('.text-center.text-muted')) box.innerHTML = '';

    box.insertAdjacentHTML('beforeend', html);
    scrollToBottom();
}

let typingTimeout = null;
function showTypingIndicator() {
    clearTimeout(typingTimeout);
    const box = document.getElementById('message-box');
    let indicator = box.querySelector('.typing-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'typing-indicator d-flex align-items-center gap-2';
        indicator.innerHTML = `
            <div class="msgr-avatar text-dark" style="width:28px;height:28px;font-size:0.8rem;font-weight:bold">K</div>
            <div class="msg-bubble msg-left">
                <span></span><span></span><span></span>
            </div>
        `;
        box.appendChild(indicator);
        scrollToBottom();
    }
}

function hideTypingIndicator() {
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        const indicator = document.querySelector('.typing-indicator');
        if (indicator) indicator.remove();
    }, 200);
}

function getRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Vừa xong';
    if (diffMins < 60) return diffMins + 'p';
    if (diffHours < 24) return diffHours + 'h';
    if (diffDays === 1) return 'Hôm qua';
    if (diffDays < 7) return diffDays + 'd';
    return date.toLocaleDateString('vi-VN');
}

function scrollToBottom() {
    const box = document.getElementById('message-box');
    box.scrollTop = box.scrollHeight;
}

// --- 4. GỬI TIN NHẮN ---
let typingSent = false;
function sendMessage() {
    const input = document.getElementById('msg-input');
    const message = input.value.trim();
    
    if (!message) return;

    if (!chatSocket || chatSocket.readyState !== WebSocket.OPEN) {
        // Fallback: Nếu socket chưa sẵn sàng, có thể báo lỗi hoặc thử gửi qua API HTTP (tùy chọn)
        alert("Mất kết nối! Đang thử kết nối lại...");
        return;
    }

    // Gửi qua WebSocket
    chatSocket.send(JSON.stringify({
        'message': message,
        'sender_id': currentUser.id, // ID của Admin đang login
        'is_staff': true // Cờ báo hiệu đây là Staff
    }));
    
    // Gửi stop_typing nếu cần
    if (typingSent) {
        chatSocket.send(JSON.stringify({ type: 'stop_typing' }));
        typingSent = false;
    }

    input.value = '';
    input.focus();
}

// Gửi typing indicator khi người dùng đang gõ
document.addEventListener('DOMContentLoaded', () => {
    const msgInput = document.getElementById('msg-input');
    if (msgInput) {
        msgInput.addEventListener('input', () => {
            if (!typingSent && chatSocket && chatSocket.readyState === WebSocket.OPEN) {
                chatSocket.send(JSON.stringify({ type: 'typing' }));
                typingSent = true;
            }
        });
    }
});

function handleEnter(e) {
    if(e.key === 'Enter') sendMessage();
}

// CSS Animation nhúng (để tin nhắn hiện mượt hơn) + Typing indicator animation
const style = document.createElement('style');
style.innerHTML = `
    .animate-fade-in { 
        animation: fadeIn 0.3s ease-in; 
    } 
    @keyframes fadeIn { 
        from { opacity:0; transform: translateY(10px); } 
        to { opacity:1; transform: translateY(0); } 
    }
    .typing-indicator span {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #999;
        display: inline-block;
        animation: typing 1.4s infinite;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing {
        0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
        30% { opacity: 1; transform: translateY(-10px); }
    }
`;
document.head.appendChild(style);
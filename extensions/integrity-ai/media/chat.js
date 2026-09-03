(function () {
	const vscode = acquireVsCodeApi();
	const messagesEl = document.getElementById('messages');
	const inputEl = document.getElementById('input');
	const sendBtn = document.getElementById('send');
	const clearBtn = document.getElementById('clear');
	const agentCheckbox = document.getElementById('agent-mode');
	const activeMentions = new Set();

	let streamingEl = null;
	let streamBuffer = '';

	document.querySelectorAll('.mention').forEach(btn => {
		btn.addEventListener('click', () => {
			const mention = btn.dataset.mention;
			if (activeMentions.has(mention)) {
				activeMentions.delete(mention);
				btn.classList.remove('active');
			} else {
				activeMentions.add(mention);
				btn.classList.add('active');
			}
		});
	});

	sendBtn.addEventListener('click', send);
	clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
	agentCheckbox.addEventListener('change', () => {
		vscode.postMessage({ type: 'toggleAgent', enabled: agentCheckbox.checked });
	});

	inputEl.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			send();
		}
	});

	function send() {
		const text = inputEl.value.trim();
		if (!text) return;
		vscode.postMessage({
			type: 'send',
			text,
			mentions: [...activeMentions],
		});
		inputEl.value = '';
	}

	function appendMessage(role, content, id) {
		const el = document.createElement('div');
		el.className = `message ${role}`;
		el.dataset.id = id || '';
		el.innerHTML = formatContent(content);
		messagesEl.appendChild(el);
		messagesEl.scrollTop = messagesEl.scrollHeight;
		return el;
	}

	function formatContent(text) {
		return escapeHtml(text)
			.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
				const encoded = encodeURIComponent(code.trim());
				return `<pre><code>${escapeHtml(code.trim())}</code></pre>
					<div class="code-actions">
						<button data-action="insert" data-code="${encoded}">Insert at cursor</button>
						<button data-action="apply" data-code="${encoded}" data-lang="${lang}">Apply to file</button>
					</div>`;
			})
			.replace(/`([^`]+)`/g, '<code>$1</code>')
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/\n/g, '<br>');
	}

	function escapeHtml(text) {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	messagesEl.addEventListener('click', (e) => {
		const btn = e.target.closest('button[data-action]');
		if (!btn) return;
		const code = decodeURIComponent(btn.dataset.code);
		if (btn.dataset.action === 'insert') {
			vscode.postMessage({ type: 'insertCode', code });
		} else {
			vscode.postMessage({ type: 'applyCode', code, language: btn.dataset.lang });
		}
	});

	window.addEventListener('message', (event) => {
		const msg = event.data;
		switch (msg.type) {
			case 'history':
				messagesEl.innerHTML = '';
				for (const m of msg.messages) {
					appendMessage(m.role, m.content, m.id);
				}
				agentCheckbox.checked = !!msg.agentMode;
				break;
			case 'userMessage':
				appendMessage('user', msg.content);
				streamBuffer = '';
				streamingEl = appendMessage('assistant', '');
				streamingEl.classList.add('streaming');
				break;
			case 'stream':
				streamBuffer += msg.content;
				if (streamingEl) {
					streamingEl.innerHTML = formatContent(streamBuffer);
					messagesEl.scrollTop = messagesEl.scrollHeight;
				}
				break;
			case 'assistantDone':
				if (streamingEl) {
					streamingEl.classList.remove('streaming');
					streamingEl.innerHTML = formatContent(msg.message.content);
				}
				streamingEl = null;
				break;
			case 'error':
				appendMessage('error', msg.message);
				if (streamingEl) {
					streamingEl.remove();
					streamingEl = null;
				}
				break;
			case 'agentMode':
				agentCheckbox.checked = !!msg.enabled;
				break;
		}
	});

	vscode.postMessage({ type: 'ready' });
})();

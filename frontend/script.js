// confession.website — a thin layer over ephemeral.website
//
// Records audio, POSTs it through ephemeral's public API, hands off the
// one-listen link. Nothing about the audio ever lives on this origin.

const API = 'https://ephemeral.website/api';

const recordBtn  = document.getElementById('record-btn');
const recordTime = document.getElementById('record-time');
const viewRecord = document.getElementById('view-record');
const viewSend   = document.getElementById('view-send');
const viewSent   = document.getElementById('view-sent');
const sendBtn    = document.getElementById('send-btn');
const redoBtn    = document.getElementById('redo-btn');
const anotherBtn = document.getElementById('another-btn');
const linkOut    = document.getElementById('link-out');
const copyBtn    = document.getElementById('copy-btn');
const shareBtn   = document.getElementById('share-btn');

let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let recordedMime = 'audio/webm';
let recordTimer = null;
let recordSeconds = 0;

const MAX_RECORD_SECONDS = 120;

function showView(name) {
    viewRecord.hidden = name !== 'record';
    viewSend.hidden   = name !== 'send';
    viewSent.hidden   = name !== 'sent';
}

function resetRecorder() {
    recordedChunks = [];
    recordedBlob = null;
    recordSeconds = 0;
    recordTime.textContent = '0:00';
    recordTime.style.transform = 'scale(1)';
    recordTime.hidden = true;
    recordBtn.classList.remove('recording');
    if (recordTimer) { clearInterval(recordTimer); recordTimer = null; }
}

recordBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        const recMime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                      : MediaRecorder.isTypeSupported('audio/mp4')  ? 'audio/mp4'
                      : '';
        mediaRecorder = recMime
            ? new MediaRecorder(stream, { mimeType: recMime })
            : new MediaRecorder(stream);
        recordedMime = mediaRecorder.mimeType || recMime || 'audio/webm';

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
            recordedBlob = new Blob(recordedChunks, { type: recordedMime });
            if (recordedBlob.size > 5 * 1024 * 1024) {
                alert('too long — confessions must be under 5MB.');
                resetRecorder();
                return;
            }
            clearInterval(recordTimer);
            recordBtn.classList.remove('recording');
            showView('send');
        };

        recordedChunks = [];
        recordSeconds = 0;
        recordTime.textContent = '0:00';
        recordTime.style.transform = 'scale(1)';
        recordTime.hidden = false;
        recordBtn.classList.add('recording');
        mediaRecorder.start();

        recordTimer = setInterval(() => {
            recordSeconds++;
            const m = Math.floor(recordSeconds / 60);
            const s = recordSeconds % 60;
            recordTime.textContent = `${m}:${s.toString().padStart(2, '0')}`;

            const half = MAX_RECORD_SECONDS / 2;
            const t = Math.max(0, (recordSeconds - half) / half);
            const scale = 1 + 2 * Math.min(t, 1);
            recordTime.style.transform = `scale(${scale})`;

            if (recordSeconds >= MAX_RECORD_SECONDS && mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
        }, 1000);
    } catch (err) {
        alert('microphone access denied.');
        console.error(err);
    }
});

redoBtn.addEventListener('click', () => {
    resetRecorder();
    showView('record');
});

sendBtn.addEventListener('click', async () => {
    if (!recordedBlob) return;
    sendBtn.disabled = true;
    sendBtn.textContent = 'sending...';

    try {
        const resp = await fetch(`${API}/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content_type: recordedMime }),
        });
        if (!resp.ok) throw new Error('upload failed');
        const data = await resp.json();

        const put = await fetch(data.upload_url, {
            method: 'PUT',
            headers: { 'Content-Type': recordedMime },
            body: recordedBlob,
        });
        if (!put.ok) throw new Error('audio upload failed');

        linkOut.value = `https://ephemeral.website/${data.token}`;
        showView('sent');
    } catch (err) {
        alert(err.message || 'send failed. try again.');
        sendBtn.disabled = false;
        sendBtn.textContent = 'confess';
    }
});

copyBtn.addEventListener('click', () => {
    linkOut.select();
    navigator.clipboard.writeText(linkOut.value);
    const orig = copyBtn.innerHTML;
    copyBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => { copyBtn.innerHTML = orig; }, 2000);
});

if (navigator.share) {
    shareBtn.hidden = false;
    shareBtn.addEventListener('click', () => {
        navigator.share({
            title: 'confession',
            text: 'a confession for you.',
            url: linkOut.value,
        });
    });
}

anotherBtn.addEventListener('click', () => {
    resetRecorder();
    sendBtn.disabled = false;
    sendBtn.textContent = 'confess';
    showView('record');
});

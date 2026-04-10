export function buildContent(data) {
    let audioUrl = null;
    if (data.audio_b64 && data.audio_mime) {
        audioUrl = `data:${data.audio_mime};base64,${data.audio_b64}`;
    }
    return {
        text: data.text || "",
        audioUrl,
    };
}

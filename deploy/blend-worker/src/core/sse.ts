import { UpstreamError } from './types.ts';

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        if (end > 8 * 1024 * 1024) throw new UpstreamError(502, 'Invalid upstream event stream.', 'stream_limit');
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
      if (buffer.length > 8 * 1024 * 1024)
        throw new UpstreamError(502, 'Invalid upstream event stream.', 'stream_limit');
      if (done) {
        if (buffer.trim()) throw new UpstreamError(502, 'Truncated upstream event stream.', 'truncated_stream', true);
        complete = true;
        break;
      }
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

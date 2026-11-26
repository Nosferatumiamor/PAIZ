// Faux serveur MCP (stdio, JSON par ligne) : un outil « echo » qui écrit un fichier marqueur quand il est appelé.
import fs from 'node:fs';
import readline from 'node:readline';
const marker = process.env.MARKER || 'marker.txt';
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo a text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  else if (m.method === 'tools/call') { fs.writeFileSync(marker, String(m.params?.arguments?.text || '')); send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo ok' }] } }); }
  else if (m.id != null) send({ jsonrpc: '2.0', id: m.id, result: {} });
});

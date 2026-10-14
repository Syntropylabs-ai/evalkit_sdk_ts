import http from 'node:http';

// A local stand-in for the OpenAI and Anthropic APIs, enough of each for the SDKs' own clients: chat
// completions and Responses, whole and streamed, and Anthropic messages, whole and streamed. The request's
// model picks the reply: "tools" asks for a tool call and says nothing, "fail" answers 400 with an API
// error, "slow" waits before its headers, "broken" drops the connection mid-stream, "drip" streams slowly.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chatChunk = (delta, finish = null, extra = {}) => ({
  id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini-2024',
  choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
});

function chatEvents(model, includeUsage) {
  const out = [];
  if (model === 'tools') {
    out.push(chatChunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '' } }] }));
    out.push(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"order_id": ' } }] }));
    out.push(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"1001"}' } }] }));
    out.push(chatChunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'refund', arguments: '{"amount": 5}' } }] }));
    out.push(chatChunk({}, 'tool_calls'));
  } else {
    out.push(chatChunk({ role: 'assistant', content: '' }));
    for (const word of ['Order ', '1001 ', 'shipped.']) out.push(chatChunk({ content: word }));
    out.push(chatChunk({}, 'stop'));
  }
  if (includeUsage) out.push({ ...chatChunk({}), choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
  return out.map((e) => `data: ${JSON.stringify(e)}\n\n`).concat(['data: [DONE]\n\n']);
}

function chatCompletion(model) {
  const message = model === 'tools'
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id": "1001"}' } }] }
    : { role: 'assistant', content: 'Order 1001 shipped.' };
  return {
    id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: 'gpt-4o-mini-2024',
    choices: [{ index: 0, message, finish_reason: model === 'tools' ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

const toolItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup_order', arguments: '{"order_id": "1001"}', status: 'completed' };
const textItem = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Order 1001 shipped.', annotations: [] }] };

function responseObject(model, output) {
  return {
    id: 'resp_mock', object: 'response', created_at: 0, status: 'completed', model: 'gpt-4.1-mini-2025', output,
    usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
}

function responsesEvents(model) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [ev('response.created', { response: { id: 'resp_mock', model: 'gpt-4.1-mini-2025', output: [] } })];
  if (model === 'tools') {
    out.push(ev('response.output_item.added', { output_index: 0, item: { ...toolItem, arguments: '', status: 'in_progress' } }));
    out.push(ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 0, delta: '{"order_id": ' }));
    out.push(ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 0, delta: '"1001"}' }));
    out.push(ev('response.output_item.done', { output_index: 0, item: toolItem }));
    out.push(ev('response.completed', { response: responseObject(model, [toolItem]) }));
  } else {
    out.push(ev('response.output_item.added', { output_index: 0, item: { ...textItem, content: [] } }));
    out.push(ev('response.content_part.added', { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
    for (const word of ['Order ', '1001 ', 'shipped.']) out.push(ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: word }));
    out.push(ev('response.output_item.done', { output_index: 0, item: textItem }));
    out.push(ev('response.completed', { response: responseObject(model, [textItem]) }));
  }
  return out;
}

function anthropicMessage(model) {
  const content = model === 'tools'
    ? [{ type: 'tool_use', id: 'toolu_1', name: 'lookup_order', input: { order_id: '1001' } }]
    : [{ type: 'text', text: 'Order 1001 shipped.' }];
  return {
    id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content,
    stop_reason: model === 'tools' ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 6 },
  };
}

function anthropicEvents(model) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [ev('message_start', { message: { ...anthropicMessage(model), content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } })];
  if (model === 'tools') {
    out.push(ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup_order', input: {} } }));
    out.push(ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"order_id": ' } }));
    out.push(ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"1001"}' } }));
    out.push(ev('content_block_stop', { index: 0 }));
    out.push(ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 6 } }));
  } else {
    out.push(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    for (const word of ['Order ', '1001 ', 'shipped.']) out.push(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: word } }));
    out.push(ev('content_block_stop', { index: 0 }));
    out.push(ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }));
  }
  out.push(ev('message_stop', {}));
  return out;
}

export async function startMockLlm() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, headers: { ...req.headers }, body });
    const model = String(body.model ?? '');
    if (model === 'fail') {
      res.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'req_fail_1' });
      res.end(JSON.stringify({ error: { message: 'forced failure', type: 'invalid_request_error', code: 'forced' } }));
      return;
    }
    if (model === 'slow') await sleep(150);
    const path = req.url ?? '';
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_ok_1' });
      if (path.endsWith('/chat/completions')) res.end(JSON.stringify(chatCompletion(model)));
      else if (path.endsWith('/responses')) res.end(JSON.stringify(responseObject(model, model === 'tools' ? [toolItem] : [textItem])));
      else res.end(JSON.stringify(anthropicMessage(model)));
      return;
    }
    const events = path.endsWith('/chat/completions')
      ? chatEvents(model, !!body.stream_options?.include_usage)
      : path.endsWith('/responses') ? responsesEvents(model) : anthropicEvents(model);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_stream_1' });
    for (let i = 0; i < events.length; i++) {
      if (res.destroyed) return;
      // Broken streams drop the connection after the reply's first words.
      if (model === 'broken' && i === (path.endsWith('/responses') ? 5 : 3)) {
        res.socket?.destroy();
        return;
      }
      res.write(events[i]);
      await sleep(model === 'drip' ? 60 : 5);
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

import { buildChatMessages } from './chatTurns.js';

const EMPTY_RESPONSE_MESSAGE = 'LLM returned an empty response';

const contentOf = (response) => {
  const content = response?.choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim() !== '' ? content : null;
};

export const createChatClient = ({ client, config }) => {
  const { model, thinking, stream, emptyRetries } = config.llm;

  const request = (messages) => client.chat.completions.create({
    model,
    ...(thinking && { thinking: { type: 'enabled' } }),
    stream,
    messages,
  });

  const complete = async ({ system, user, turns = [] }) => {
    const messages = buildChatMessages({ system, user, turns });
    for (let attempt = 0; attempt <= emptyRetries; attempt += 1) {
      const content = contentOf(await request(messages));
      if (content !== null) return content;
    }
    throw new Error(EMPTY_RESPONSE_MESSAGE);
  };

  return { complete };
};

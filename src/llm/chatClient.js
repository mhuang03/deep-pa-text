const EMPTY_RESPONSE_MESSAGE = 'LLM returned an empty response';

const contentOf = (response) => {
  const content = response?.choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim() !== '' ? content : null;
};

export const createChatClient = ({ client, config }) => {
  const { model, thinking, stream, emptyRetries } = config.llm;

  const request = (system, user) => client.chat.completions.create({
    model,
    ...(thinking && { thinking: { type: 'enabled' } }),
    stream,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const complete = async ({ system, user }) => {
    for (let attempt = 0; attempt <= emptyRetries; attempt += 1) {
      const content = contentOf(await request(system, user));
      if (content !== null) return content;
    }
    throw new Error(EMPTY_RESPONSE_MESSAGE);
  };

  return { complete };
};

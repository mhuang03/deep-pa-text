export const createChatClient = ({ client, config }) => {
  const { model, thinking, stream } = config.llm;

  const complete = async ({ system, user }) => {
    const response = await client.chat.completions.create({
      model,
      ...(thinking && { thinking: { type: 'enabled' } }),
      stream,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return response.choices[0].message.content;
  };

  return { complete };
};

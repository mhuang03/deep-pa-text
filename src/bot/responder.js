export const DELIVERY_STAGE = 'delivery';

// Lets handlers tell a send failure (arm the rate limit) from a generation failure.
const markDelivery = (error) => {
  const marked = error instanceof Error ? error : new Error(String(error), { cause: error });
  return Object.assign(marked, { stage: DELIVERY_STAGE });
};

export const createResponder = ({ composer, delivery }) => {
  const respond = async ({ persona, target, guild, via }) => {
    const { response, content, gifLinks } = await composer.compose({ persona, target });
    try {
      const message = await delivery.deliver({ via, persona, guild, content, gifLinks });
      return { response, message };
    } catch (error) {
      throw markDelivery(error);
    }
  };

  return { respond };
};

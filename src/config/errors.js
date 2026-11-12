// Operator mistakes (bad environment, bad data files) are told apart from bugs by this marker;
// entry points print only the message for them.
export const createConfigError = (message) => Object.assign(new Error(message), { isConfigError: true });

export const isConfigError = (error) => error?.isConfigError === true;

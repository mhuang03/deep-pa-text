// Spec 02 change 7: the send is deliberately not awaited, but a rejection is logged instead of
// surfacing as an unhandled rejection. A synchronous throw from `send` still propagates.
export const sendDetached = ({ send, logger, errorLabel }) =>
  Promise.resolve(send()).catch((error) => logger.error(errorLabel, error));

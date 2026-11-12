const SIGNALS = ['SIGINT', 'SIGTERM'];
const FAILURES = ['unhandledRejection', 'uncaughtException'];
const FAILURE_EXIT_CODE = 1;

// A crash skips the grace period: state after an unexpected error cannot be trusted to finish work.
export const installProcessHooks = ({ process, lifecycle, logger }) => {
  SIGNALS.forEach((signal) => {
    process.on(signal, () => {
      if (lifecycle.isShuttingDown()) {
        logger.error(`Received ${signal} again during shutdown; exiting now.`);
        process.exit(FAILURE_EXIT_CODE);
        return;
      }
      lifecycle.shutdown({ reason: signal, code: 0 });
    });
  });
  FAILURES.forEach((event) => {
    process.on(event, (error) => {
      logger.error(`${event}:`, error);
      lifecycle.shutdown({ reason: event, code: FAILURE_EXIT_CODE, graceMs: 0 });
    });
  });
};

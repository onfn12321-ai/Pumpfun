export class ExecutionSafetyError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ExecutionSafetyError";
  }
}

export class UncertainExecutionError extends ExecutionSafetyError {
  constructor(message: string, code = "APPROVAL_UNCERTAIN") {
    super(message, code);
    this.name = "UncertainExecutionError";
  }
}

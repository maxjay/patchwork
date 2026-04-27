export class OnionskinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class SessionAlreadyOpenError extends OnionskinError {
  constructor() {
    super('A user session is already open');
  }
}

export class CopilotAlreadyOpenError extends OnionskinError {
  constructor() {
    super('A copilot session is already open');
  }
}

export class SessionClosedError extends OnionskinError {
  constructor() {
    super('This session has been closed');
  }
}

export class CopilotSessionOpenError extends OnionskinError {
  constructor() {
    super('Cannot commit while a copilot session is open');
  }
}

export class NoOpAtPathError extends OnionskinError {
  constructor(path: string) {
    super(`No active op at path: ${path}`);
  }
}

export class InvalidPathError extends OnionskinError {
  constructor(path: string) {
    super(`Invalid JSON Pointer: ${path}`);
  }
}

export class PathNotFoundError extends OnionskinError {
  constructor(path: string) {
    super(`Path does not exist: ${path}`);
  }
}

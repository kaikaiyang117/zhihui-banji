/* MIG-02 统一错误类型：业务错误携带 HTTP 状态码与 detail 文案（对齐 FastAPI）。 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly detail: string;
  readonly code?: string;

  constructor(statusCode: number, detail: string, code?: string) {
    super(detail);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.detail = detail;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(detail = '资源不存在') {
    super(404, detail, 'not_found');
  }
}

export class BadRequestError extends AppError {
  constructor(detail: string) {
    super(400, detail, 'bad_request');
  }
}

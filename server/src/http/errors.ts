/** REST 层可预期异常：携带 HTTP 状态码与业务错误码 */
import type { ApiErrorBody } from '../../../shared/transfer'

export class HttpFailure extends Error {
  constructor(
    public statusCode: number,
    public code: ApiErrorBody['error']['code'],
    message: string,
  ) {
    super(message)
    this.name = 'HttpFailure'
  }
}

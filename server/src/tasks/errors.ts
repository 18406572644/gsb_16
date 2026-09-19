/** 转换任务相关错误类型 */

/** 确定性失败：重试不会改变结果（文件损坏、格式不支持、参数非法等） */
export class FatalConvertError extends Error {
  constructor(
    message: string,
    public code: string = 'CONVERT_FAILED',
  ) {
    super(message)
    this.name = 'FatalConvertError'
  }
}

/** 任务被用户取消（协作式取消点抛出） */
export class CanceledError extends Error {
  constructor(message = '任务已取消') {
    super(message)
    this.name = 'CanceledError'
  }
}

export function isFatal(e: unknown): boolean {
  return e instanceof FatalConvertError
}

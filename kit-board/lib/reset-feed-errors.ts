export type ResetFeedFailure =
  | `http_${number}`
  | 'timeout'
  | 'network_error'
  | 'unexpected_content_type'
  | 'empty_response'
  | 'response_too_large'
  | 'invalid_json'
  | 'schema_changed'
  | 'feed_unavailable_or_changed';

export function resetFeedFailure(error: unknown): ResetFeedFailure {
  if (error instanceof Error && /^http_\d{3}$/.test(error.message)) return error.message as `http_${number}`;
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'timeout';
  if (error instanceof SyntaxError) return 'invalid_json';
  if (error instanceof Error && /schema changed/i.test(error.message)) return 'schema_changed';
  if (error instanceof Error && ['unexpected_content_type', 'empty_response', 'response_too_large'].includes(error.message)) {
    return error.message as ResetFeedFailure;
  }
  if (error instanceof TypeError) return 'network_error';
  return 'feed_unavailable_or_changed';
}

export function resetFeedFailureLabel(value: string | null | undefined) {
  if (!value) return null;
  const code = value.replace(/^v\d+:/, '');
  const status = /^http_(\d{3})$/.exec(code)?.[1];
  if (status) return `source returned HTTP ${status}`;
  return ({
    timeout: 'source request timed out',
    network_error: 'source connection failed',
    unexpected_content_type: 'source returned non-JSON content',
    empty_response: 'source returned an empty response',
    response_too_large: 'source response exceeded the size limit',
    invalid_json: 'source returned invalid JSON',
    schema_changed: 'source JSON schema changed',
    feed_unavailable_or_changed: 'source unavailable or changed',
  } as Record<string, string>)[code] ?? 'source unavailable or changed';
}

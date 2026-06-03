// Shared map: Axios span ID → OTel Span.
// patchAxios writes to it; patchHttp reads from it to merge Axios spans with
// the full Node.js-level request headers instead of creating a duplicate span.
export const _evalkitAxiosSpanMap = new Map<string, any>();

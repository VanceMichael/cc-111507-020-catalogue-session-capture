function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { const value = parseJson(bytes); return { format: '联合目录会话资料', recordsOnPage: value?.records?.length || 0 }; }

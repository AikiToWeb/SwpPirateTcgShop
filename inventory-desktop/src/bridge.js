export async function request(method, args) {
  if (!window.inventory?.[method]) throw new Error('설치형 프로그램에서 실행해 주세요. 재고 DB에 연결할 수 없습니다.');
  const result = await window.inventory[method](args);
  if (!result?.ok) {
    const error = new Error(result?.error?.message || '처리하지 못했습니다. 다시 시도해 주세요.');
    error.code = result?.error?.code;
    throw error;
  }
  return result.data;
}

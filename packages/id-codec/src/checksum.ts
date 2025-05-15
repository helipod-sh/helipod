/**
 * Fletcher-16 checksum. Appended to each document id so a corrupted or fabricated id is
 * rejected client-side without a database round-trip.
 */
export function fletcher16(bytes: Uint8Array): number {
  let sum1 = 0;
  let sum2 = 0;
  for (let i = 0; i < bytes.length; i++) {
    sum1 = (sum1 + bytes[i]!) % 255;
    sum2 = (sum2 + sum1) % 255;
  }
  return (sum2 << 8) | sum1;
}

export function verifyFletcher16(bytes: Uint8Array, checksum: number): boolean {
  return fletcher16(bytes) === checksum;
}

/** PCM/IEEE float RIFF WAV, measured in samples without rounding to milliseconds. */
export function wavDuration(bytes: Buffer): number {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw new Error("WAV 文件不完整。");
  let offset = 12;
  let rate = 0;
  let align = 0;
  let sampleRate = 0;
  let data = 0;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + length > bytes.length) throw new Error("WAV 数据不完整。");
    const tag = bytes.toString("ascii", offset, offset + 4);
    if (tag === "fmt " && length >= 16) {
      const encoding = bytes.readUInt16LE(offset + 8);
      if (![1, 3, 65534].includes(encoding))
        throw new Error("WAV 编码不支持。");
      sampleRate = bytes.readUInt32LE(offset + 12);
      rate = bytes.readUInt32LE(offset + 16);
      align = bytes.readUInt16LE(offset + 20);
    }
    if (tag === "data") data += length;
    offset += 8 + length + (length % 2);
  }
  if (
    !data ||
    !sampleRate ||
    !align ||
    data % align ||
    rate !== sampleRate * align
  )
    throw new Error("WAV 采样信息不正确。");
  return data / align / sampleRate;
}

export type AnnexBCodec = "h264" | "hevc";

export interface AnnexBNalUnit {
  type: number;
  data: Uint8Array;
}

const maximumNalUnitCount = 1_024;
const maximumParameterSetBytes = 64 * 1_024;

export function nalType(codec: AnnexBCodec, data: Uint8Array): number {
  if (!data.byteLength) return -1;
  return codec === "h264" ? data[0]! & 0x1f : (data[0]! >> 1) & 0x3f;
}

export function parseAnnexB(data: Uint8Array, codec: AnnexBCodec): AnnexBNalUnit[] {
  const starts: Array<{ offset: number; length: number }> = [];
  for (let offset = 0; offset + 3 <= data.byteLength;) {
    let length = 0;
    if (data[offset] === 0 && data[offset + 1] === 0) {
      if (data[offset + 2] === 1) length = 3;
      else if (offset + 4 <= data.byteLength && data[offset + 2] === 0 && data[offset + 3] === 1)
        length = 4;
    }
    if (!length) {
      offset += 1;
      continue;
    }
    starts.push({ offset, length });
    if (starts.length > maximumNalUnitCount)
      throw new Error(`${codecLabel(codec)} access unit has too many NAL units`);
    offset += length;
  }

  const units: AnnexBNalUnit[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const payloadStart = start.offset + start.length;
    let payloadEnd = starts[index + 1]?.offset ?? data.byteLength;
    while (payloadEnd > payloadStart && data[payloadEnd - 1] === 0) payloadEnd -= 1;
    if (payloadStart >= payloadEnd) continue;
    const unit = data.slice(payloadStart, payloadEnd);
    units.push({ type: nalType(codec, unit), data: unit });
  }
  return units;
}

export function annexBToLengthPrefixed(units: readonly AnnexBNalUnit[]): Uint8Array {
  const length = units.reduce((total, unit) => total + 4 + unit.data.byteLength, 0);
  const result = new Uint8Array(length);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const unit of units) {
    if (!unit.data.byteLength || unit.data.byteLength > 0xffff_ffff)
      throw new Error("invalid Annex-B NAL unit");
    view.setUint32(offset, unit.data.byteLength);
    offset += 4;
    result.set(unit.data, offset);
    offset += unit.data.byteLength;
  }
  return result;
}

export function accessUnits(
  units: readonly AnnexBNalUnit[],
  codec: AnnexBCodec,
): AnnexBNalUnit[][] {
  const result: AnnexBNalUnit[][] = [];
  let current: AnnexBNalUnit[] = [];
  let hasSlice = false;
  for (const unit of units) {
    const slice = isSlice(codec, unit.type);
    const beginsNext =
      hasSlice &&
      (slice ? firstSliceIsZero(unit.data, codec) : !isAccessUnitSuffix(codec, unit.type));
    if (beginsNext) {
      result.push(current);
      current = [];
      hasSlice = false;
    }
    current.push(unit);
    if (slice) hasSlice = true;
  }
  if (current.length) result.push(current);
  return result;
}

export function videoParameterSets(
  units: readonly AnnexBNalUnit[],
  codec: AnnexBCodec,
): { vps: Uint8Array[]; sps: Uint8Array[]; pps: Uint8Array[] } {
  const vps: Uint8Array[] = [];
  const sps: Uint8Array[] = [];
  const pps: Uint8Array[] = [];
  let totalBytes = 0;
  for (const unit of units) {
    let destination: Uint8Array[] | undefined;
    if (codec === "hevc" && unit.type === 32) destination = vps;
    if (unit.type === (codec === "h264" ? 7 : 33)) destination = sps;
    if (unit.type === (codec === "h264" ? 8 : 34)) destination = pps;
    if (!destination) continue;
    if (unit.data.byteLength > maximumParameterSetBytes)
      throw new Error(`${codecLabel(codec)} parameter sets exceed 64 KiB`);
    totalBytes += unit.data.byteLength;
    if (totalBytes > maximumParameterSetBytes)
      throw new Error(`${codecLabel(codec)} parameter sets exceed 64 KiB`);
    destination.push(unit.data);
  }
  return { vps, sps, pps };
}

export function isSlice(codec: AnnexBCodec, type: number): boolean {
  return codec === "h264" ? type >= 1 && type <= 5 : type >= 0 && type <= 31;
}

export function isIdr(codec: AnnexBCodec, type: number): boolean {
  return codec === "h264" ? type === 5 : type === 19 || type === 20;
}

export function isIrap(codec: AnnexBCodec, type: number): boolean {
  return codec === "h264" ? isIdr(codec, type) : type >= 16 && type <= 21;
}

export function isRasl(codec: AnnexBCodec, type: number): boolean {
  return codec === "hevc" && (type === 8 || type === 9);
}

export class AnnexBDecodeGate {
  readonly codec: AnnexBCodec;
  waitingForRandomAccess = true;
  suppressingRasl = false;

  constructor(codec: AnnexBCodec) {
    this.codec = codec;
  }

  reset(): void {
    this.waitingForRandomAccess = true;
    this.suppressingRasl = false;
  }

  shouldDecode(units: readonly AnnexBNalUnit[]): boolean {
    const types = units.map((unit) => unit.type);
    if (this.waitingForRandomAccess) {
      if (!types.some((type) => isIrap(this.codec, type))) return false;
      this.waitingForRandomAccess = false;
      this.suppressingRasl =
        this.codec === "hevc" && !types.some((type) => isIdr(this.codec, type));
      return true;
    }
    if (!this.suppressingRasl) return true;
    const sliceTypes = types.filter((type) => isSlice(this.codec, type));
    if (sliceTypes.some((type) => isRasl(this.codec, type))) return false;
    const irapTypes = sliceTypes.filter((type) => isIrap(this.codec, type));
    if (irapTypes.length) this.suppressingRasl = !irapTypes.some((type) => isIdr(this.codec, type));
    else if (sliceTypes.some((type) => type !== 6 && type !== 7)) this.suppressingRasl = false;
    return true;
  }
}

function firstSliceIsZero(data: Uint8Array, codec: AnnexBCodec): boolean {
  const offset = codec === "h264" ? 1 : 2;
  return data.byteLength <= offset || Boolean(data[offset]! & 0x80);
}

function isAccessUnitSuffix(codec: AnnexBCodec, type: number): boolean {
  if (codec !== "hevc") return false;
  return (
    (type >= 36 && type <= 38) ||
    type === 40 ||
    (type >= 45 && type <= 47) ||
    (type >= 56 && type <= 63)
  );
}

function codecLabel(codec: AnnexBCodec): string {
  return codec === "h264" ? "H.264" : "HEVC";
}

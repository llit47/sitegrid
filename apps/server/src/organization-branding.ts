import sharp from 'sharp';
import type { PoolClient } from 'pg';

export const logoByteLimit = 262144;
export const defaultAccentColor = '#163638';
export const brandingFailure = (statusCode: number) => Object.assign(new Error('Invalid branding action'), { statusCode });

export async function readBranding(client: PoolClient, organizationId: string) {
  return (await client.query(`SELECT o.id AS "organizationId", o.name,
    COALESCE(s.accent_color, $2) AS "accentColor", COALESCE(s.version, 1) AS version,
    CASE WHEN l.organization_id IS NULL THEN NULL ELSE json_build_object('version', l.version, 'mimeType', l.mime_type) END AS logo
    FROM organizations o LEFT JOIN organization_settings s ON s.organization_id = o.id
    LEFT JOIN organization_logos l ON l.organization_id = o.id WHERE o.id = $1`, [organizationId, defaultAccentColor])).rows[0];
}

// Decode actual pixels and encode a new raster. Never retain metadata or trailing payloads.
export async function validateLogo(mimeType: unknown, base64: unknown) {
  const formats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' } as const;
  if (typeof mimeType !== 'string' || !Object.hasOwn(formats, mimeType) || typeof base64 !== 'string') throw brandingFailure(400);
  if (base64.length > 4 * Math.ceil(logoByteLimit / 3)) throw brandingFailure(413);
  if (!base64 || base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw brandingFailure(400);
  const input = Buffer.from(base64, 'base64');
  if (input.length > logoByteLimit) throw brandingFailure(413);
  if (input.toString('base64') !== base64) throw brandingFailure(400);
  const format = formats[mimeType as keyof typeof formats];
  // Block SVG and other decoders before passing any input to the raster library.
  const signature = format === 'png' ? input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : format === 'jpeg' ? input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff
    : input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
  if (!signature) throw brandingFailure(400);
  try {
    const decoder = sharp(input, { failOn: 'warning', limitInputPixels: 1024 * 1024, sequentialRead: true });
    const metadata = await decoder.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height
      || metadata.width > 1024 || metadata.height > 1024 || (metadata.pages ?? 1) !== 1) throw brandingFailure(400);
    const data = await decoder.rotate().toFormat(format).timeout({ seconds: 3 }).toBuffer();
    if (data.length > logoByteLimit) throw brandingFailure(413);
    return { data, mimeType };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) throw error;
    throw brandingFailure(400);
  }
}

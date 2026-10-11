import sharp from 'sharp';
import { createHash } from 'node:crypto';
export const photoLimit = 10 * 1024 ** 2, requestLimit = 50 * 1024 ** 2;
export const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export function mediaFailure(statusCode: number, code: string, message: string) {
  return Object.assign(new Error(message), { statusCode, code });
}
export async function normalizePhoto(input: Buffer, mime: string) {
  if (input.length > photoLimit) throw mediaFailure(413,'PHOTO_TOO_LARGE','Zdjęcie przekracza 10 MiB.');
  const brands = input.toString('ascii', 4, 32);
  if (/ftyp.*(?:hei[cf]|heix|hevc|mif1|msf1)/.test(brands) || /hei[cf]/i.test(mime))
    throw mediaFailure(415,'HEIC_UNSUPPORTED','HEIC/HEIF nie jest obsługiwany. Wybierz lub wyeksportuj zdjęcie jako JPEG, PNG lub WebP.');
  const format = input[0]===255 && input[1]===216 && input[2]===255 ? 'jpeg'
    : input.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) ? 'png'
    : input.toString('ascii',0,4)==='RIFF' && input.toString('ascii',8,12)==='WEBP' ? 'webp' : null;
  if (!format) throw mediaFailure(415,'PHOTO_UNSUPPORTED','Obsługiwane zdjęcia: JPEG, PNG i WebP.');
  if (mime !== `image/${format}`) throw mediaFailure(415,'PHOTO_MIME_MISMATCH','Typ pliku nie odpowiada zawartości zdjęcia.');
  try {
    const decoder = sharp(input,{ failOn:'warning',limitInputPixels:40_000_000,sequentialRead:true });
    const info = await decoder.metadata();
    if (info.format!==format || !info.width || !info.height || info.width>12000 || info.height>12000
      || info.width*info.height>40_000_000 || (info.pages??1)!==1)
      throw mediaFailure(422,'PHOTO_DIMENSIONS','Zdjęcie musi mieć maksymalnie 40 megapikseli i 12000 px na bok, bez animacji.');
    const original = await decoder.rotate().flatten({background:'#ffffff'}).jpeg({quality:90}).timeout({seconds:10}).toBuffer({resolveWithObject:true});
    if (original.data.length>photoLimit) throw mediaFailure(413,'PHOTO_TOO_LARGE','Zdjęcie po przetworzeniu przekracza 10 MiB.');
    const thumbnail = await sharp(original.data).resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();
    return { original:original.data,thumbnail,width:original.info.width,height:original.info.height,
      original_bytes:original.data.length,thumbnail_bytes:thumbnail.length,original_sha256:digest(original.data),thumbnail_sha256:digest(thumbnail) };
  } catch (e) {
    if ((e as {statusCode?:number}).statusCode) throw e;
    if (/pixel limit/.test((e as Error).message)) throw mediaFailure(422,'PHOTO_DIMENSIONS','Zdjęcie przekracza limit 40 megapikseli.');
    throw mediaFailure(422,'PHOTO_CORRUPTED','Nie można odczytać zdjęcia. Plik jest uszkodzony lub niekompletny.');
  }
}

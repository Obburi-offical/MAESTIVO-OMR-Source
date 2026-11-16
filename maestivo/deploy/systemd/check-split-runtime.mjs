// Fixed runtime preflight, not a license approval or performance test.
import {lstat,readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const CONFIG='/srv/maestivo/audiveris/lib/app/Audiveris.cfg';
const CONFIG_SHA256='749c84a4fd90901f8561ad02f7e934d1071e7a65a3c259d8f3ef2c3f6d20eac1';

export function validateJavaConfig(text) {
  if(typeof text!=='string' || text.length>131072) throw Error('INVALID_JAVA_CONFIG');
  const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(line=>line.startsWith('java-options='));
  const maximum=lines.filter(line=>/-Xmx|-XX:MaxRAM(?:Percentage|=)/i.test(line));
  const initial=lines.filter(line=>/-Xms|-XX:InitialRAMPercentage/i.test(line));
  if(maximum.length!==1 || maximum[0]!=='java-options=-Xmx256m' || initial.length!==1 || initial[0]!=='java-options=-Xms64m')
    throw Error('UNREVIEWED_JAVA_HEAP');
  return true;
}
export async function verifyConfig(path=CONFIG) {
  if(path!==CONFIG || await realpath(path)!==path) throw Error('UNTRUSTED_JAVA_CONFIG');
  for(let current=path;;current=dirname(current)) {
    const info=await lstat(current), file=current===path;
    if(info.isSymbolicLink() || info.uid!==0 || (info.mode&0o022)!==0 || (file?!info.isFile():!info.isDirectory()) || (file && info.size>131072))
      throw Error('UNTRUSTED_JAVA_CONFIG');
    if(current==='/') break;
  }
  const text=await readFile(path,'utf8');
  if(createHash('sha256').update(text).digest('hex')!==CONFIG_SHA256) throw Error('UNREVIEWED_JAVA_CONFIG');
  return validateJavaConfig(text);
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {await verifyConfig();console.log('Reviewed Java heap configuration confirmed.');}
  catch {console.error('Java heap configuration refused.');process.exitCode=1;}
}

import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { getCmBase } from './server';
import { currentSession, loadSession } from './tokens';
import { ApiError } from '../api/client';

export interface PickedFile { uri: string; name: string; type: string; size?: number }

/** What the backend accepts for claim documents and payment proofs (PDF and common images; the server re-checks the content). */
const ACCEPT = ['application/pdf', 'image/*'];

export async function pickDocument(): Promise<PickedFile | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: ACCEPT, copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  return { uri: a.uri, name: a.name || 'document', type: a.mimeType || 'application/octet-stream', size: a.size };
}

export async function pickPhoto(camera = false): Promise<PickedFile | null> {
  const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new ApiError(0, 'PERMISSION_DENIED', 'Permission was not granted.');
  const r = camera
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  return { uri: a.uri, name: a.fileName || `photo-${Date.now()}.jpg`, type: a.mimeType || 'image/jpeg', size: a.fileSize };
}

/** React Native's FormData accepts {uri, name, type} for a file part. */
export function filePart(f: PickedFile): any {
  return { uri: Platform.OS === 'ios' ? f.uri.replace('file://', '') : f.uri, name: f.name, type: f.type } as any;
}

/**
 * Downloads a document through the authenticated Customer Management route and opens the share sheet (save / open / send).
 * The file is written to the app's private cache and never to shared storage.
 */
export async function downloadDocument(handle: string, fallbackName: string): Promise<void> {
  await loadSession();
  const s = currentSession();
  if (!s) throw new ApiError(401, 'SESSION_EXPIRED', 'Please sign in again.');
  const safe = fallbackName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'document.pdf';
  const target = `${FileSystem.cacheDirectory}${Date.now()}-${safe}`;
  const res = await FileSystem.downloadAsync(`${getCmBase()}/documents/download?handle=${encodeURIComponent(handle)}`, target, {
    headers: { Authorization: `Bearer ${s.accessToken}` },
  });
  if (res.status === 401) throw new ApiError(401, 'SESSION_EXPIRED', 'Please sign in again.');
  if (res.status >= 400) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new ApiError(res.status, res.status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', 'Could not download this document.');
  }
  if (!(await Sharing.isAvailableAsync())) throw new ApiError(0, 'SHARING_UNAVAILABLE', 'Saving files is not available on this device.');
  await Sharing.shareAsync(res.uri, { mimeType: res.headers?.['Content-Type'] || res.headers?.['content-type'], dialogTitle: fallbackName });
}

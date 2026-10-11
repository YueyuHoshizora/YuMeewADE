export const featureZhTW = {
  'sideDiff.side': '並排差異', 'sideDiff.unified': '統一差異', 'sideDiff.before': '原始', 'sideDiff.after': '修改後',
  'sideDiff.binary': '二進位檔案無法並排顯示，保留統一差異。', 'sideDiff.large': '檔案超過 1 MiB，保留統一差異。',
};
type Keys = keyof typeof featureZhTW;
export const featureZhCN: Record<Keys, string> = {
  'sideDiff.side': '并排差异', 'sideDiff.unified': '统一差异', 'sideDiff.before': '原始', 'sideDiff.after': '修改后',
  'sideDiff.binary': '二进制文件无法并排显示，保留统一差异。', 'sideDiff.large': '文件超过 1 MiB，保留统一差异。',
};
export const featureEn: Record<Keys, string> = {
  'sideDiff.side': 'Side by side', 'sideDiff.unified': 'Unified diff', 'sideDiff.before': 'Original', 'sideDiff.after': 'Modified',
  'sideDiff.binary': 'Binary file: keeping the unified diff.', 'sideDiff.large': 'File exceeds 1 MiB: keeping the unified diff.',
};
export const featureJa: Record<Keys, string> = {
  'sideDiff.side': '左右比較', 'sideDiff.unified': '統一差分', 'sideDiff.before': '変更前', 'sideDiff.after': '変更後',
  'sideDiff.binary': 'バイナリファイルのため統一差分を表示します。', 'sideDiff.large': '1 MiB を超えるため統一差分を表示します。',
};
export const featureDe: Record<Keys, string> = {
  'sideDiff.side': 'Nebeneinander', 'sideDiff.unified': 'Vereinheitlichtes Diff', 'sideDiff.before': 'Original', 'sideDiff.after': 'Geändert',
  'sideDiff.binary': 'Binärdatei: vereinheitlichtes Diff bleibt sichtbar.', 'sideDiff.large': 'Datei über 1 MiB: vereinheitlichtes Diff bleibt sichtbar.',
};
export const featureFr: Record<Keys, string> = {
  'sideDiff.side': 'Côte à côte', 'sideDiff.unified': 'Diff unifié', 'sideDiff.before': 'Original', 'sideDiff.after': 'Modifié',
  'sideDiff.binary': 'Fichier binaire : conservation du diff unifié.', 'sideDiff.large': 'Fichier de plus de 1 MiB : conservation du diff unifié.',
};
export const featureIt: Record<Keys, string> = {
  'sideDiff.side': 'Affiancato', 'sideDiff.unified': 'Diff unificato', 'sideDiff.before': 'Originale', 'sideDiff.after': 'Modificato',
  'sideDiff.binary': 'File binario: resta visibile il diff unificato.', 'sideDiff.large': 'File oltre 1 MiB: resta visibile il diff unificato.',
};

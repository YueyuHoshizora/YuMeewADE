/** CodeMirror's built-in panel strings (search, go to line, lint, folding); applied through EditorState.phrases. */
export const featureZhTW = {
  'cm.find': '尋找', 'cm.replace': '取代為', 'cm.next': '下一個', 'cm.previous': '上一個', 'cm.all': '全部',
  'cm.matchCase': '區分大小寫', 'cm.regexp': '正規表達式', 'cm.byWord': '完整單字', 'cm.replaceOne': '取代', 'cm.replaceAll': '全部取代',
  'cm.close': '關閉', 'cm.currentMatch': '目前符合項目', 'cm.onLine': '位於第', 'cm.replacedMatches': '已取代 $ 處',
  'cm.replacedOnLine': '已取代第 $ 行的符合項目', 'cm.gotoLine': '跳到行', 'cm.go': '前往', 'cm.diagnostics': '診斷',
  'cm.noDiagnostics': '沒有診斷', 'cm.completions': '自動完成', 'cm.foldedCode': '已摺疊的程式碼', 'cm.unfold': '展開',
  'cm.to': '至', 'cm.controlCharacter': '控制字元', 'cm.selectionDeleted': '已刪除選取內容',
};
type Keys = keyof typeof featureZhTW;
export const featureZhCN: Record<Keys, string> = {
  'cm.find': '查找', 'cm.replace': '替换为', 'cm.next': '下一个', 'cm.previous': '上一个', 'cm.all': '全部',
  'cm.matchCase': '区分大小写', 'cm.regexp': '正则表达式', 'cm.byWord': '全字匹配', 'cm.replaceOne': '替换', 'cm.replaceAll': '全部替换',
  'cm.close': '关闭', 'cm.currentMatch': '当前匹配项', 'cm.onLine': '位于第', 'cm.replacedMatches': '已替换 $ 处',
  'cm.replacedOnLine': '已替换第 $ 行的匹配项', 'cm.gotoLine': '跳到行', 'cm.go': '前往', 'cm.diagnostics': '诊断',
  'cm.noDiagnostics': '没有诊断', 'cm.completions': '自动补全', 'cm.foldedCode': '已折叠的代码', 'cm.unfold': '展开',
  'cm.to': '至', 'cm.controlCharacter': '控制字符', 'cm.selectionDeleted': '已删除选中内容',
};
export const featureEn: Record<Keys, string> = {
  'cm.find': 'Find', 'cm.replace': 'Replace', 'cm.next': 'next', 'cm.previous': 'previous', 'cm.all': 'all',
  'cm.matchCase': 'match case', 'cm.regexp': 'regexp', 'cm.byWord': 'by word', 'cm.replaceOne': 'replace', 'cm.replaceAll': 'replace all',
  'cm.close': 'close', 'cm.currentMatch': 'current match', 'cm.onLine': 'on line', 'cm.replacedMatches': 'replaced $ matches',
  'cm.replacedOnLine': 'replaced match on line $', 'cm.gotoLine': 'Go to line', 'cm.go': 'go', 'cm.diagnostics': 'Diagnostics',
  'cm.noDiagnostics': 'No diagnostics', 'cm.completions': 'Completions', 'cm.foldedCode': 'folded code', 'cm.unfold': 'unfold',
  'cm.to': 'to', 'cm.controlCharacter': 'Control character', 'cm.selectionDeleted': 'Selection deleted',
};
export const featureJa: Record<Keys, string> = {
  'cm.find': '検索', 'cm.replace': '置換後', 'cm.next': '次へ', 'cm.previous': '前へ', 'cm.all': 'すべて',
  'cm.matchCase': '大文字小文字を区別', 'cm.regexp': '正規表現', 'cm.byWord': '単語単位', 'cm.replaceOne': '置換', 'cm.replaceAll': 'すべて置換',
  'cm.close': '閉じる', 'cm.currentMatch': '現在の一致', 'cm.onLine': '行', 'cm.replacedMatches': '$ 件を置換しました',
  'cm.replacedOnLine': '$ 行目の一致を置換しました', 'cm.gotoLine': '行へ移動', 'cm.go': '移動', 'cm.diagnostics': '診断',
  'cm.noDiagnostics': '診断はありません', 'cm.completions': '補完候補', 'cm.foldedCode': '折りたたまれたコード', 'cm.unfold': '展開',
  'cm.to': '～', 'cm.controlCharacter': '制御文字', 'cm.selectionDeleted': '選択範囲を削除しました',
};
export const featureDe: Record<Keys, string> = {
  'cm.find': 'Suchen', 'cm.replace': 'Ersetzen durch', 'cm.next': 'weiter', 'cm.previous': 'zurück', 'cm.all': 'alle',
  'cm.matchCase': 'Groß-/Kleinschreibung', 'cm.regexp': 'Regulärer Ausdruck', 'cm.byWord': 'ganzes Wort', 'cm.replaceOne': 'ersetzen', 'cm.replaceAll': 'alle ersetzen',
  'cm.close': 'schließen', 'cm.currentMatch': 'aktueller Treffer', 'cm.onLine': 'in Zeile', 'cm.replacedMatches': '$ Treffer ersetzt',
  'cm.replacedOnLine': 'Treffer in Zeile $ ersetzt', 'cm.gotoLine': 'Gehe zu Zeile', 'cm.go': 'los', 'cm.diagnostics': 'Diagnosen',
  'cm.noDiagnostics': 'Keine Diagnosen', 'cm.completions': 'Vervollständigungen', 'cm.foldedCode': 'eingeklappter Code', 'cm.unfold': 'ausklappen',
  'cm.to': 'bis', 'cm.controlCharacter': 'Steuerzeichen', 'cm.selectionDeleted': 'Auswahl gelöscht',
};
export const featureFr: Record<Keys, string> = {
  'cm.find': 'Rechercher', 'cm.replace': 'Remplacer par', 'cm.next': 'suivant', 'cm.previous': 'précédent', 'cm.all': 'tout',
  'cm.matchCase': 'respecter la casse', 'cm.regexp': 'expression régulière', 'cm.byWord': 'mot entier', 'cm.replaceOne': 'remplacer', 'cm.replaceAll': 'tout remplacer',
  'cm.close': 'fermer', 'cm.currentMatch': 'occurrence actuelle', 'cm.onLine': 'à la ligne', 'cm.replacedMatches': '$ occurrences remplacées',
  'cm.replacedOnLine': 'occurrence remplacée à la ligne $', 'cm.gotoLine': 'Aller à la ligne', 'cm.go': 'aller', 'cm.diagnostics': 'Diagnostics',
  'cm.noDiagnostics': 'Aucun diagnostic', 'cm.completions': 'Complétions', 'cm.foldedCode': 'code replié', 'cm.unfold': 'déplier',
  'cm.to': 'à', 'cm.controlCharacter': 'Caractère de contrôle', 'cm.selectionDeleted': 'Sélection supprimée',
};
export const featureIt: Record<Keys, string> = {
  'cm.find': 'Trova', 'cm.replace': 'Sostituisci con', 'cm.next': 'successivo', 'cm.previous': 'precedente', 'cm.all': 'tutti',
  'cm.matchCase': 'maiuscole/minuscole', 'cm.regexp': 'espressione regolare', 'cm.byWord': 'parola intera', 'cm.replaceOne': 'sostituisci', 'cm.replaceAll': 'sostituisci tutto',
  'cm.close': 'chiudi', 'cm.currentMatch': 'corrispondenza attuale', 'cm.onLine': 'alla riga', 'cm.replacedMatches': '$ corrispondenze sostituite',
  'cm.replacedOnLine': 'corrispondenza sostituita alla riga $', 'cm.gotoLine': 'Vai alla riga', 'cm.go': 'vai', 'cm.diagnostics': 'Diagnostica',
  'cm.noDiagnostics': 'Nessuna diagnostica', 'cm.completions': 'Completamenti', 'cm.foldedCode': 'codice compresso', 'cm.unfold': 'espandi',
  'cm.to': 'a', 'cm.controlCharacter': 'Carattere di controllo', 'cm.selectionDeleted': 'Selezione eliminata',
};

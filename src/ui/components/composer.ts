export function shouldSend(event: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, enterToSend: boolean): boolean {
  if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter' || event.altKey) return false;
  return enterToSend ? !event.shiftKey : event.metaKey || event.ctrlKey;
}

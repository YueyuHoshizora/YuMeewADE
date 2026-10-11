export interface UpdateDownloadResult {
  token: string;
  name: string;
  integrity: boolean;
  publisherTrusted: boolean;
  canLaunch: boolean;
}

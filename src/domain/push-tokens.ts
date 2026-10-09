import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type PushRegistration = {
  walletAddress: string;
  token: string;
  updatedAt: string;
};

// One registered push token per wallet (re-registering replaces it -- a wallet only gets one device's
// worth of alerts in this model). Same file-backed pattern as the other stores; survives a restart.
export class FilePushTokenStore {
  private registrations: PushRegistration[] | null = null;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded() {
    if (this.registrations) return this.registrations;
    try {
      this.registrations = JSON.parse(await readFile(this.filePath, 'utf8')) as PushRegistration[];
    } catch {
      this.registrations = [];
    }
    return this.registrations;
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.registrations, null, 2), 'utf8');
  }

  async register(walletAddress: string, token: string) {
    const registrations = await this.ensureLoaded();
    const next = registrations.filter((r) => r.walletAddress !== walletAddress && r.token !== token);
    next.push({ walletAddress, token, updatedAt: new Date().toISOString() });
    this.registrations = next;
    await this.persist();
  }

  async unregister(walletAddress: string) {
    const registrations = await this.ensureLoaded();
    this.registrations = registrations.filter((r) => r.walletAddress !== walletAddress);
    await this.persist();
  }

  async tokensFor(walletAddress: string): Promise<string[]> {
    const registrations = await this.ensureLoaded();
    return registrations.filter((r) => r.walletAddress === walletAddress).map((r) => r.token);
  }

  async isRegistered(walletAddress: string): Promise<boolean> {
    return (await this.tokensFor(walletAddress)).length > 0;
  }
}

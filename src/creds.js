export class Creds {
  constructor(cfg) {
    this.cfg = cfg;
  }

  token() {
    const c = this.cfg.creds || {};
    return {
      bearer: c.bearer || '',
      deviceId: c.deviceId || '',
      rangersId: c.rangersId || '',
    };
  }

  ok() {
    const t = this.token();
    return !!(t.bearer && t.deviceId);
  }
}

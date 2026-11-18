export interface MediamtxConfigOptions {
  rtspPort: number;
  apiPort: number;
  authUrl: string;
}

// 讀取只開 TCP：UDP 要多開 8000/8001 兩個 port，而本機 worker 與 HA 都走 TCP。
// 沒有 paths 條目就不會有 all_others，所以外部無法憑空建立 path。
// moq 預設會開 8892/8893 並在工作目錄寫憑證，必須關掉。
export function renderMediamtxConfig(o: MediamtxConfigOptions): string {
  return `logLevel: info
readTimeout: 10s
writeTimeout: 10s

authMethod: http
authHTTPAddress: ${JSON.stringify(o.authUrl)}
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof

authInternalUsers:
  - user: any
    pass:
    ips: ["127.0.0.1", "::1"]
    permissions:
      - action: api

api: true
apiAddress: 127.0.0.1:${o.apiPort}
metrics: false
pprof: false
playback: false

rtsp: true
rtspTransports: [tcp]
rtspEncryption: "no"
rtspAddress: :${o.rtspPort}
rtspAuthMethods: [basic]

rtmp: false
hls: false
webrtc: false
srt: false
moq: false

paths: {}
`;
}

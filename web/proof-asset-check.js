const copy = {
  ko: {
    back: '← 탐색', title: '브라우저 증명 파일 검사',
    description: 'Midnight Preprod 테스트 계약의 발행·입찰 회로 파일이 이 사이트에서 읽히고 배포된 소스와 일치하는지 확인합니다. 약 25MB를 다운로드합니다.',
    run: '파일 검사 시작', checking: '파일 목록과 배포된 소스를 확인하고 있습니다…',
    checkingMint: '발행 회로 파일 3개를 다운로드해 검사하고 있습니다…',
    checkingBid: '입찰 회로 파일 3개를 다운로드해 검사하고 있습니다. 이 단계는 시간이 걸릴 수 있습니다…',
    idle: '이 검사는 지갑 연결, 증명 생성, 서명 또는 거래를 수행하지 않습니다.',
    success: '6개 파일의 크기·SHA-256과 Preprod 계약 소스 해시가 일치합니다. 지갑 증명이나 거래는 수행하지 않았습니다.',
    failed: '검사 실패',
  },
  en: {
    back: '← Explore', title: 'Browser proof-file check',
    description: 'Check that this site serves the mint and bid circuit files for the Midnight Preprod test contract and that they match the deployed source. This downloads about 25 MB.',
    run: 'Check files', checking: 'Checking the manifest and deployed source…',
    checkingMint: 'Downloading and checking three mint-circuit files…',
    checkingBid: 'Downloading and checking three bid-circuit files. This step may take a while…',
    idle: 'This check does not connect a wallet, generate a proof, sign, or submit a transaction.',
    success: 'All six file sizes, SHA-256 hashes, and the Preprod contract source hash match. No wallet proof or transaction was performed.',
    failed: 'Check failed',
  },
};

let language;
try { language = localStorage.getItem('fair-launch-locale'); } catch { /* browser storage may be unavailable */ }
if (language !== 'ko' && language !== 'en') language = navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
let statusKey = 'idle';
let failureDetail = '';

function render() {
  document.documentElement.lang = language;
  document.querySelector('#backLink').textContent = copy[language].back;
  document.querySelector('#title').textContent = copy[language].title;
  document.querySelector('#description').textContent = copy[language].description;
  document.querySelector('#runCheck').textContent = copy[language].run;
  document.querySelector('#localeToggle').textContent = language === 'ko' ? 'EN' : 'KO';
  document.querySelector('#status').textContent = statusKey === 'failed'
    ? `${copy[language].failed}: ${failureDetail}` : copy[language][statusKey];
}

document.querySelector('#localeToggle').addEventListener('click', () => {
  language = language === 'ko' ? 'en' : 'ko';
  try { localStorage.setItem('fair-launch-locale', language); } catch { /* language still changes in this tab */ }
  render();
});

document.querySelector('#runCheck').addEventListener('click', async () => {
  const button = document.querySelector('#runCheck');
  button.disabled = true;
  statusKey = 'checking';
  render();
  try {
    const { verifyBrowserZkAssets } = await import('./assets/fair-launch-client.js');
    const [manifestResponse, evidenceResponse] = await Promise.all([
      fetch('./zk/manifest.json', { cache: 'no-store' }),
      fetch('./preprod-launch-evidence.json', { cache: 'no-store' }),
    ]);
    if (!manifestResponse.ok || !evidenceResponse.ok) throw new Error('Setup record unavailable');
    const [manifest, evidence] = await Promise.all([manifestResponse.json(), evidenceResponse.json()]);
    if (manifest.network !== 'preprod' || manifest.sourceHash !== evidence.sourceHash || manifest.files?.length !== 6) {
      throw new Error('Source or manifest mismatch');
    }
    const expected = new Map(manifest.files.map((file) => [file.path, file]));
    for (const circuit of ['mintTestPaymentCoin', 'registerBid']) {
      statusKey = circuit === 'mintTestPaymentCoin' ? 'checkingMint' : 'checkingBid';
      render();
      const actual = await verifyBrowserZkAssets('./zk/', circuit);
      for (const [path, bytes, hash] of [
        [`keys/${circuit}.prover`, actual.proverBytes, actual.proverSha256],
        [`keys/${circuit}.verifier`, actual.verifierBytes, actual.verifierSha256],
        [`zkir/${circuit}.bzkir`, actual.zkirBytes, actual.zkirSha256],
      ]) {
        const item = expected.get(path);
        if (!item || item.bytes !== bytes || item.sha256 !== hash) throw new Error(`Artifact mismatch: ${path}`);
      }
    }
    statusKey = 'success';
    render();
  } catch (error) {
    statusKey = 'failed';
    failureDetail = error instanceof Error ? error.message : 'unknown error';
    render();
  } finally { button.disabled = false; }
});

render();

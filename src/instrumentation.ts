export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if(process.env.MG_BUILD==='1')return;
    const { validateEncryptionKey }=await import('./lib/crypto');
    const { allowedOrigins }=await import('./lib/origin');
    validateEncryptionKey();allowedOrigins();
    const { startWorker,stopWorker } = await import("./lib/worker");
    startWorker();
    let stopping=false;
    const shutdown=()=>{if(stopping)return;stopping=true;void stopWorker().then(()=>process.exit(0)).catch(()=>process.exit(1));};
    process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  }
}

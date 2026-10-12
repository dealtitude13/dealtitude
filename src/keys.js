/* Generates the VAPID pair. Run once; paste into .env and never regenerate —
   new keys invalidate every subscription you have. */
import webpush from "web-push";
const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);

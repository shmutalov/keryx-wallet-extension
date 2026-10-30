// Store screenshot captions and the demo AI prompt, per locale. Scenes are in upload
// order; each caption names what the screen beneath it shows.

export const SCENES = ['dashboard', 'ai', 'consolidate', 'receive', 'approval'];

export const CAPTIONS = {
  en: {
    dashboard: ['Your KRX, one click from any tab', 'Balance, history and network status in the toolbar. Keys never leave your device.'],
    ai: ['Ask private AI, pay per question in KRX', 'Your prompt is encrypted so only the miners serving the model can read it.'],
    consolidate: ['Merge pool payouts in one click', 'Hundreds of small UTXOs become one, so large sends go through.'],
    receive: ['Get paid with a QR code', 'Phone mode opens your address in any phone browser, ready to copy.'],
    approval: ['You approve every dApp request', 'See the site, amounts and fee before anything is signed.'],
  },
  de: {
    dashboard: ['Ihre KRX, ein Klick aus jedem Tab', 'Guthaben, Verlauf und Netzwerkstatus in der Symbolleiste. Schlüssel verlassen nie Ihr Gerät.'],
    ai: ['Private KI fragen, pro Frage in KRX zahlen', 'Ihr Prompt wird verschlüsselt – nur die Miner des Modells können ihn lesen.'],
    consolidate: ['Pool-Auszahlungen mit einem Klick bündeln', 'Hunderte kleine UTXOs werden zu einem, damit große Überweisungen durchgehen.'],
    receive: ['Per QR-Code bezahlt werden', 'Der Modus „Telefon“ öffnet Ihre Adresse in jedem Handy-Browser zum Kopieren.'],
    approval: ['Sie genehmigen jede dApp-Anfrage', 'Website, Beträge und Gebühr sehen, bevor etwas signiert wird.'],
  },
  es: {
    dashboard: ['Tus KRX, a un clic desde cualquier pestaña', 'Saldo, historial y estado de la red en la barra. Tus claves nunca salen de tu dispositivo.'],
    ai: ['Pregunta a una IA privada y paga en KRX', 'Tu pregunta se cifra para que solo los mineros del modelo puedan leerla.'],
    consolidate: ['Junta los pagos del pool con un clic', 'Cientos de UTXOs pequeños se vuelven uno para que los envíos grandes funcionen.'],
    receive: ['Recibe pagos con un código QR', 'El modo Teléfono abre tu dirección en el navegador de cualquier celular, lista para copiar.'],
    approval: ['Tú apruebas cada solicitud de una dApp', 'Ve el sitio, los montos y la comisión antes de firmar nada.'],
  },
  fr: {
    dashboard: ['Vos KRX, à un clic de chaque onglet', 'Solde, historique et état du réseau dans la barre d’outils. Vos clés ne quittent jamais votre appareil.'],
    ai: ['Interrogez une IA privée, payez en KRX', 'Votre question est chiffrée : seuls les mineurs du modèle peuvent la lire.'],
    consolidate: ['Regroupez les paiements de pool en un clic', 'Des centaines de petits UTXO n’en font plus qu’un, et les gros envois passent.'],
    receive: ['Recevez par code QR', 'Le mode Téléphone ouvre votre adresse dans le navigateur de n’importe quel mobile, prête à copier.'],
    approval: ['Vous approuvez chaque demande de dApp', 'Site, montants et frais affichés avant toute signature.'],
  },
  pt_BR: {
    dashboard: ['Seus KRX a um clique de qualquer aba', 'Saldo, histórico e status da rede na barra de ferramentas. Suas chaves nunca saem do dispositivo.'],
    ai: ['Pergunte a uma IA privada e pague em KRX', 'Sua pergunta é criptografada para que só os mineradores do modelo possam lê-la.'],
    consolidate: ['Junte os pagamentos do pool com um clique', 'Centenas de UTXOs pequenos viram um só, e envios grandes funcionam.'],
    receive: ['Receba com um código QR', 'O modo Celular abre seu endereço no navegador de qualquer celular, pronto para copiar.'],
    approval: ['Você aprova cada solicitação de dApp', 'Veja o site, os valores e a taxa antes de qualquer assinatura.'],
  },
  ru: {
    dashboard: ['Ваши KRX — в один клик из любой вкладки', 'Баланс, история и статус сети на панели браузера. Ключи не покидают устройство.'],
    ai: ['Приватный ИИ с оплатой в KRX за вопрос', 'Вопрос шифруется — прочитать его могут только майнеры выбранной модели.'],
    consolidate: ['Объединяйте выплаты пула в один клик', 'Сотни мелких UTXO становятся одним, и крупные переводы проходят.'],
    receive: ['Получайте KRX по QR-коду', 'Режим «Телефон» открывает адрес в браузере любого смартфона — его легко скопировать.'],
    approval: ['Каждый запрос dApp подтверждаете вы', 'Сайт, суммы и комиссия видны до подписи.'],
  },
  zh_CN: {
    dashboard: ['您的 KRX，在任意标签页一键可达', '工具栏中即可查看余额、交易记录和网络状态。密钥永不离开您的设备。'],
    ai: ['向私密 AI 提问，按次用 KRX 付费', '您的问题经过加密，只有提供该模型的矿工才能读取。'],
    consolidate: ['一键合并矿池收益', '数百个小额 UTXO 合并为一个，大额转账顺利完成。'],
    receive: ['用二维码收款', '“手机”模式可在任意手机浏览器中打开您的地址，方便复制。'],
    approval: ['每个 dApp 请求都由您批准', '签名前即可看到网站、金额和手续费。'],
  },
};

export const PROMPTS = {
  en: 'Explain proof-of-model mining in two sentences.',
  de: 'Erkläre Proof-of-Model-Mining in zwei Sätzen.',
  es: 'Explica la minería proof-of-model en dos frases.',
  fr: 'Explique le minage proof-of-model en deux phrases.',
  pt_BR: 'Explique a mineração proof-of-model em duas frases.',
  ru: 'Объясни майнинг proof-of-model в двух предложениях.',
  zh_CN: '用两句话解释模型证明（PoM）挖矿。',
};

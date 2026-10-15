import { Bot } from './yapper.js';

const bot = new Bot('yb_84f083ec.OdbHc4wKyP9tDRlF8-xLdZ57flOF9WcPbLuq1Sju');
bot.command('ping', 'Is the bot alive?', (msg) => msg.reply('pong 🏓'));
bot.on('message', (msg) => { if (msg.mentioned) msg.reply('hey!'); });
bot.start();

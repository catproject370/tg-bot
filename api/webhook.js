import { kv } from '@vercel/kv';
import axios from 'axios';

// Вспомогательная функция для отправки сообщений в Telegram
async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: String(chatId), text: text, parse_mode: 'HTML' });
  } catch (error) {
    console.error('Ошибка отправки в Telegram:', error.message);
  }
}

// Вспомогательная функция для сохранения данных через Apps Script
async function saveToSheet(data) {
  try {
    await axios.post(process.env.APPS_SCRIPT_URL, data, {
      headers: { 'Authorization': `Bearer ${process.env.APPS_SCRIPT_SECRET}` }
    });
    return true;
  } catch (error) {
    console.error('Ошибка сохранения в Sheets:', error.response ? error.response.data : error.message);
    await sendTelegramMessage(process.env.DEV_CHAT_ID, `🚨 Ошибка сохранения в Sheets: ${error.message}`);
    return false;
  }
}

// Основной обработчик вебхука
export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).send('Method Not Allowed');

  try {
    const update = request.body;
    if (!update?.message?.text) return response.status(200).send('OK');

    const { message } = update;
    const chatId = message.chat.id.toString();
    const text = message.text.trim();

    const stateKey = `state:${chatId}`;
    const nameKey = `name:${chatId}`;
    const currentStatus = await kv.get(stateKey);

    if (text === '/reset') {
      await kv.del(stateKey, nameKey);
      await sendTelegramMessage(chatId, 'Состояние сброшено. Начните с /start');
    } 
    else if (text.startsWith('/start')) {
      await kv.del(stateKey, nameKey);
      await sendTelegramMessage(chatId, `🚀 Добро пожаловать!\n\nВведите ваше имя:`);
      await kv.set(stateKey, 'waiting_for_name');
    } 
    else if (currentStatus === 'waiting_for_name') {
      await kv.set(nameKey, text);
      await sendTelegramMessage(chatId, 'Отлично! Теперь введите ваш email:');
      await kv.set(stateKey, 'waiting_for_email');
    } 
    else if (currentStatus === 'waiting_for_email') {
      const name = await kv.get(nameKey);
      if (!name) {
        await kv.del(stateKey);
        return await sendTelegramMessage(chatId, 'Ошибка, имя не найдено. Начните с /start');
      }
      
      const saved = await saveToSheet([chatId, name, text, new Date().toISOString(), 'новый']);
      if (saved) {
        await sendTelegramMessage(chatId, `Спасибо, ${name}! 🎯 Ваша заявка принята.`);
        if (process.env.DEV_CHAT_ID) {
          await sendTelegramMessage(process.env.DEV_CHAT_ID, `🔔 Новая заявка: ${name}, ${text}`);
        }
      } else {
        await sendTelegramMessage(chatId, 'Произошла ошибка при сохранении заявки.');
      }
      await kv.del(stateKey, nameKey);
    } 
    else {
      await sendTelegramMessage(chatId, 'Отправьте /start для начала.');
    }
  } catch (error) {
    console.error('Критическая ошибка:', error);
    if (process.env.DEV_CHAT_ID) {
      await sendTelegramMessage(process.env.DEV_CHAT_ID, `💥 Критическая ошибка: ${error.message}`);
    }
  } finally {
    return response.status(200).send('OK');
  }
}
import { sql } from '@vercel/postgres';
import axios from 'axios';

// =================================================================
//                 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =================================================================

async function sendTelegramMessage(chatId, text) {
  // Эта функция остается без изменений
  const botToken = process.env.BOT_TOKEN;
  if (!botToken || !chatId || !text) return;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await axios.post(url, { chat_id: String(chatId), text: text, parse_mode: 'HTML' });
  } catch (error) { console.error('Ошибка отправки в Telegram:', error.message); }
}

// --- ИЗМЕНЕННАЯ ФУНКЦИЯ СОХРАНЕНИЯ ---
async function saveToSheet(data) {
  try {
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    const secret = process.env.APPS_SCRIPT_SECRET;

    // Создаем новый "пакет" данных, который включает и секрет, и данные пользователя
    const payload = {
      secret: secret,
      data: data
    };

    // Отправляем этот пакет. Заголовки больше не нужны.
    const response = await axios.post(appsScriptUrl, payload, { timeout: 10000 });

    if (response.status === 200 && response.data.status === 'ok') {
      return true;
    } else {
      throw new Error(`Unexpected response from Apps Script: ${JSON.stringify(response.data)}`);
    }
  } catch (error) {
    console.error('Ошибка сохранения в Google Sheets:', error.response ? error.response.data : error.message);
    await sendTelegramMessage(process.env.DEV_CHAT_ID, `🚨 Ошибка сохранения в Google Sheets: ${error.message}`);
    return false;
  }
}


// =================================================================
//                 ОСНОВНОЙ ОБРАБОТЧИК WEBHOOK
// =================================================================
export default async function handler(request, response) {
  // Эта часть остается полностью без изменений
  if (request.method !== 'POST') return response.status(405).send('Method Not Allowed');
  try {
    const update = request.body;
    if (!update?.message?.text) return response.status(200).send('OK');
    const { message } = update;
    const chatId = message.chat.id.toString();
    const text = message.text.trim();
    const { rows } = await sql`SELECT state, user_name FROM user_states WHERE chat_id = ${chatId};`;
    const userState = rows[0];
    const currentStatus = userState?.state;

    if (text === '/reset') {
      await sql`DELETE FROM user_states WHERE chat_id = ${chatId};`;
      await sendTelegramMessage(chatId, 'Состояние сброшено. Начните с /start');
    } 
    else if (text.startsWith('/start')) {
      await sql`INSERT INTO user_states (chat_id, state) VALUES (${chatId}, 'waiting_for_name') ON CONFLICT (chat_id) DO UPDATE SET state = 'waiting_for_name', user_name = NULL;`;
      await sendTelegramMessage(chatId, `🚀 Добро пожаловать!\n\nВведите ваше имя:`);
    } 
    else if (currentStatus === 'waiting_for_name') {
      await sql`UPDATE user_states SET user_name = ${text}, state = 'waiting_for_email' WHERE chat_id = ${chatId};`;
      await sendTelegramMessage(chatId, 'Отлично! Теперь введите ваш email:');
    } 
    else if (currentStatus === 'waiting_for_email') {
      const name = userState?.user_name;
      if (!name) {
        await sql`DELETE FROM user_states WHERE chat_id = ${chatId};`;
        return await sendTelegramMessage(chatId, 'Ошибка, имя не найдено. Начните с /start');
      }
      const saved = await saveToSheet([chatId, name, text, new Date().toISOString(), 'новый']);
      if (saved) {
        await sendTelegramMessage(chatId, `Спасибо, ${name}! 🎯 Ваша заявка принята.`);
        if (process.env.DEV_CHAT_ID) {
          await sendTelegramMessage(process.env.DEV_CHAT_ID, `🔔 Новая заявка: ${name}, ${text}`);
        }
      } else {
        await sendTelegramMessage(chatId, 'Произошла ошибка при сохранении заявки. Пожалуйста, попробуйте позже.');
      }
      await sql`DELETE FROM user_states WHERE chat_id = ${chatId};`;
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


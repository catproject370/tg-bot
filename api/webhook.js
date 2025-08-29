import { sql } from '@vercel/postgres';
import axios from 'axios';

// =================================================================
//                 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =================================================================

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: String(chatId), text: text, parse_mode: 'HTML' });
  } catch (error) { console.error('Ошибка отправки в Telegram:', error.message); }
}

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


// =================================================================
//                 ОСНОВНОЙ ОБРАБОТЧИК WEBHOOK
// =================================================================
export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).send('Method Not Allowed');

  try {
    const update = request.body;
    if (!update?.message?.text) return response.status(200).send('OK');

    const { message } = update;
    const chatId = message.chat.id.toString();
    const text = message.text.trim();

    // Получаем текущее состояние пользователя из Postgres
    let userState = null;
    const { rows } = await sql`SELECT state, user_name FROM user_states WHERE chat_id = ${chatId};`;
    if (rows.length > 0) {
      userState = { state: rows[0].state, name: rows[0].user_name };
    }
    const currentStatus = userState ? userState.state : null;

    if (text === '/reset') {
      await sql`DELETE FROM user_states WHERE chat_id = ${chatId};`;
      await sendTelegramMessage(chatId, 'Состояние сброшено. Начните с /start');
    } 
    else if (text.startsWith('/start')) {
      // Создаем или обновляем запись пользователя, сбрасывая состояние
      await sql`
        INSERT INTO user_states (chat_id, state, user_name) 
        VALUES (${chatId}, 'waiting_for_name', NULL)
        ON CONFLICT (chat_id) 
        DO UPDATE SET state = 'waiting_for_name', user_name = NULL, updated_at = NOW();
      `;
      await sendTelegramMessage(chatId, `🚀 Добро пожаловать!\n\nВведите ваше имя:`);
    } 
    else if (currentStatus === 'waiting_for_name') {
      // Обновляем запись пользователя, добавляя имя и меняя состояние
      await sql`
        UPDATE user_states 
        SET user_name = ${text}, state = 'waiting_for_email', updated_at = NOW() 
        WHERE chat_id = ${chatId};
      `;
      await sendTelegramMessage(chatId, 'Отлично! Теперь введите ваш email:');
    } 
    else if (currentStatus === 'waiting_for_email') {
      const name = userState ? userState.name : null;
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
        await sendTelegramMessage(chatId, 'Произошла ошибка при сохранении заявки.');
      }
      // Удаляем запись о состоянии после успешного диалога
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
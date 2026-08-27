const fs = require('fs');
const axios = require('axios');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

async function syncContent() {
    try {
        console.log('Fetching content from live server...');
        const response = await axios.get('https://rajabsynic.com/api/content');
        const liveContent = response.data;
        
        if (Array.isArray(liveContent) && liveContent.length > 0) {
            const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            dbData.content = liveContent;
            fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
            console.log('Successfully synced ' + liveContent.length + ' items to local DB.');
        } else {
            console.log('No content found on live server or invalid response.');
        }
    } catch (e) {
        console.error('Error fetching live content:', e.message);
    }
}

syncContent();

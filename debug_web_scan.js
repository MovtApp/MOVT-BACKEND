const axios = require('axios');

async function debug() {
    try {
        const url = 'https://nitrogymacademia.com.br/';
        const res = await axios.get(url, { timeout: 5000 });
        const html = res.data;
        
        const wrongNum = '51965570342';
        const index = html.indexOf(wrongNum);
        if (index !== -1) {
            console.log('Wrong number context:');
            console.log(html.substring(index - 200, index + 200));
        }

        const rightNum = '11986430468';
        const index2 = html.indexOf(rightNum);
        if (index2 !== -1) {
            console.log('\nRight number context:');
            console.log(html.substring(index2 - 200, index2 + 200));
        }
    } catch (e) {
        console.error(e.message);
    }
}

debug();

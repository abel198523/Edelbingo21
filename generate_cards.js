function generateBingoCard() {
    const card = [];
    const used = new Set();
    
    for (let row = 0; row < 5; row++) {
        const rowData = [];
        for (let col = 0; col < 5; col++) {
            if (row === 2 && col === 2) {
                rowData.push(0); // Free space
                continue;
            }
            
            const min = col * 15 + 1;
            const max = (col + 1) * 15;
            let num;
            do {
                num = Math.floor(Math.random() * (max - min + 1)) + min;
            } while (used.has(num));
            
            used.add(num);
            rowData.push(num);
        }
        card.push(rowData);
    }
    return card;
}

const cards = {};
for (let i = 1; i <= 100; i++) {
    cards[i] = generateBingoCard();
}

console.log('const BINGO_CARDS = ' + JSON.stringify(cards, null, 2) + ';');

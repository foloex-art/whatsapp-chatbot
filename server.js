const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const speech = require('@google-cloud/speech');
const textToSpeech = require('@google-cloud/text-to-speech');
const fs = require('fs');
const https = require('https');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

// Google Cloud Speech-to-Text client
const speechClient = new speech.SpeechClient({
    credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ? 
        { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS } :
        {
            projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
            private_key: process.env.GOOGLE_CLOUD_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.GOOGLE_CLOUD_CLIENT_EMAIL
        }
});

// Google Cloud Text-to-Speech client  
const ttsClient = new textToSpeech.TextToSpeechClient({
    credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ? 
        { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS } :
        {
            projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
            private_key: process.env.GOOGLE_CLOUD_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.GOOGLE_CLOUD_CLIENT_EMAIL
        }
});

// In-memory storage for user sessions and orders
const userSessions = new Map();
const orders = new Map();

// Sample restaurant menu
const menu = {
    starters: [
        { id: 'S1', name: 'Spring Rolls', price: 8.99, description: 'Crispy vegetable spring rolls (4 pcs)' },
        { id: 'S2', name: 'Chicken Wings', price: 12.99, description: 'Spicy buffalo wings (8 pcs)' },
        { id: 'S3', name: 'Garlic Bread', price: 6.99, description: 'Homemade garlic bread with herbs' }
    ],
    mains: [
        { id: 'M1', name: 'Margherita Pizza', price: 16.99, description: 'Fresh tomato, mozzarella, basil' },
        { id: 'M2', name: 'Chicken Burger', price: 14.99, description: 'Grilled chicken with lettuce, tomato' },
        { id: 'M3', name: 'Pasta Carbonara', price: 18.99, description: 'Creamy pasta with bacon and parmesan' },
        { id: 'M4', name: 'Fish & Chips', price: 19.99, description: 'Beer battered cod with crispy fries' }
    ],
    desserts: [
        { id: 'D1', name: 'Chocolate Cake', price: 7.99, description: 'Rich chocolate cake with vanilla ice cream' },
        { id: 'D2', name: 'Tiramisu', price: 8.99, description: 'Classic Italian dessert' }
    ],
    drinks: [
        { id: 'DR1', name: 'Coca Cola', price: 3.99, description: 'Classic soft drink' },
        { id: 'DR2', name: 'Fresh Orange Juice', price: 4.99, description: 'Freshly squeezed orange juice' },
        { id: 'DR3', name: 'Coffee', price: 3.49, description: 'Freshly brewed coffee' }
    ]
};

// Create temp directory for audio files
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// Helper functions
function getUserSession(phoneNumber) {
    if (!userSessions.has(phoneNumber)) {
        userSessions.set(phoneNumber, {
            cart: [],
            currentStep: 'welcome',
            orderInProgress: false,
            preferVoice: false
        });
    }
    return userSessions.get(phoneNumber);
}

function formatMenuItem(item) {
    return `${item.id}. ${item.name} - $${item.price}\n   ${item.description}`;
}

function formatMenuCategory(categoryName, items) {
    let message = `??? *${categoryName.toUpperCase()}*\n\n`;
    items.forEach(item => {
        message += formatMenuItem(item) + '\n\n';
    });
    return message;
}

function formatCart(cart) {
    if (cart.length === 0) {
        return '?? Your cart is empty.\n\nSay "menu" or type "menu" to browse our menu!';
    }
    
    let message = '?? *YOUR CART*\n\n';
    let total = 0;
    
    cart.forEach(item => {
        const subtotal = item.price * item.quantity;
        total += subtotal;
        message += `${item.name} x${item.quantity} - $${subtotal.toFixed(2)}\n`;
    });
    
    message += `\n*Total: $${total.toFixed(2)}*\n\n`;
    message += 'Say "checkout" to place your order\n';
    message += 'Say "clear cart" to empty cart\n';
    message += 'Say "menu" to continue shopping';
    
    return message;
}

function findMenuItem(itemId) {
    const allItems = [...menu.starters, ...menu.mains, ...menu.desserts, ...menu.drinks];
    return allItems.find(item => item.id.toLowerCase() === itemId.toLowerCase());
}

function findMenuItemByName(itemName) {
    const allItems = [...menu.starters, ...menu.mains, ...menu.desserts, ...menu.drinks];
    return allItems.find(item => 
        item.name.toLowerCase().includes(itemName.toLowerCase()) ||
        itemName.toLowerCase().includes(item.name.toLowerCase())
    );
}

function generateOrderId() {
    return 'ORD' + Date.now().toString().slice(-6);
}

// Voice processing functions
async function downloadAudioFile(audioUrl, filename) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filename);
        https.get(audioUrl, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(filename);
            });
        }).on('error', (err) => {
            fs.unlink(filename, () => {}); // Delete the file on error
            reject(err);
        });
    });
}

async function transcribeAudio(audioFilePath) {
    try {
        const audioBytes = fs.readFileSync(audioFilePath).toString('base64');
        
        const request = {
            audio: {
                content: audioBytes,
            },
            config: {
                encoding: 'OGG_OPUS', // WhatsApp voice messages are typically in OGG format
                sampleRateHertz: 16000,
                languageCode: 'en-US',
                alternativeLanguageCodes: ['en-GB', 'es-ES', 'fr-FR'], // Support multiple languages
                enableAutomaticPunctuation: true,
                enableWordTimeOffsets: false,
            },
        };

        const [response] = await speechClient.recognize(request);
        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join('\n');
            
        // Clean up the audio file
        fs.unlink(audioFilePath, (err) => {
            if (err) console.error('Error deleting audio file:', err);
        });
        
        return transcription;
    } catch (error) {
        console.error('Error transcribing audio:', error);
        throw error;
    }
}

async function generateVoiceResponse(text) {
    try {
        const request = {
            input: { text: text },
            voice: {
                languageCode: 'en-US',
                name: 'en-US-Wavenet-F', // Female voice
                ssmlGender: 'FEMALE',
            },
            audioConfig: {
                audioEncoding: 'OGG_OPUS',
                speakingRate: 0.9,
                pitch: 0.0,
            },
        };

        const [response] = await ttsClient.synthesizeSpeech(request);
        
        // Save audio file temporarily
        const audioFilename = `voice_response_${Date.now()}.ogg`;
        const audioPath = path.join(tempDir, audioFilename);
        
        fs.writeFileSync(audioPath, response.audioContent, 'binary');
        
        return audioPath;
    } catch (error) {
        console.error('Error generating voice response:', error);
        return null;
    }
}

// Enhanced text processing for voice commands
function processVoiceCommand(text) {
    const lowerText = text.toLowerCase();
    
    // Handle natural language ordering
    if (lowerText.includes('add') || lowerText.includes('order') || lowerText.includes('want')) {
        // Extract items and quantities from natural speech
        const quantities = lowerText.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/g);
        let quantity = 1;
        
        if (quantities) {
            const numberWords = {
                'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
                'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10
            };
            const lastQuantity = quantities[quantities.length - 1];
            quantity = numberWords[lastQuantity] || parseInt(lastQuantity) || 1;
        }
        
        // Find menu item by name matching
        const allItems = [...menu.starters, ...menu.mains, ...menu.desserts, ...menu.drinks];
        for (const item of allItems) {
            if (lowerText.includes(item.name.toLowerCase()) || 
                item.name.toLowerCase().includes(lowerText.replace(/add|order|want|i|to|the|a|an/g, '').trim())) {
                return `add ${item.id} ${quantity}`;
            }
        }
    }
    
    // Map common voice commands to text commands
    const voiceCommands = {
        'show menu': 'menu',
        'view menu': 'menu',
        'see menu': 'menu',
        'menu please': 'menu',
        'show cart': 'cart',
        'view cart': 'cart',
        'my cart': 'cart',
        'check cart': 'cart',
        'clear cart': 'clear',
        'empty cart': 'clear',
        'remove all': 'clear',
        'check out': 'checkout',
        'place order': 'checkout',
        'complete order': 'checkout',
        'finish order': 'checkout',
        'show starters': 'starters',
        'show appetizers': 'starters',
        'show mains': 'mains',
        'show main courses': 'mains',
        'show desserts': 'desserts',
        'show drinks': 'drinks',
        'show beverages': 'drinks',
        'help me': 'help',
        'what can i do': 'help',
        'how does this work': 'help'
    };
    
    for (const [voice, command] of Object.entries(voiceCommands)) {
        if (lowerText.includes(voice)) {
            return command;
        }
    }
    
    return text;
}

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.send('Voice-Enabled Restaurant WhatsApp Ordering Bot is running! ?????');
});

// Webhook endpoint for incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
    try {
        const fromNumber = req.body.From;
        const session = getUserSession(fromNumber);
        
        let incomingMessage = '';
        let isVoiceMessage = false;
        
        // Check if it's a voice message
        if (req.body.MediaUrl0 && req.body.MediaContentType0 && 
            req.body.MediaContentType0.startsWith('audio/')) {
            
            isVoiceMessage = true;
            session.preferVoice = true; // User prefers voice interaction
            
            console.log(`Received voice message from ${fromNumber}`);
            
            try {
                // Download and transcribe voice message
                const audioUrl = req.body.MediaUrl0;
                const audioFilename = path.join(tempDir, `audio_${Date.now()}.ogg`);
                
                await downloadAudioFile(audioUrl, audioFilename);
                const transcription = await transcribeAudio(audioFilename);
                
                incomingMessage = transcription.toLowerCase().trim();
                console.log(`Transcribed: "${transcription}"`);
                
                if (!incomingMessage) {
                    throw new Error('Could not transcribe audio');
                }
                
            } catch (error) {
                console.error('Error processing voice message:', error);
                const errorResponse = `??? Sorry, I couldn't understand your voice message. Please try again or send a text message.
                
You can also type your order using commands like:
• "menu" - to see our menu
• "add M1 2" - to add items
• "cart" - to view your order`;
                
                await sendResponse(fromNumber, errorResponse, false);
                return res.status(200).send('Error response sent');
            }
            
        } else {
            // Regular text message
            incomingMessage = req.body.Body?.toLowerCase().trim() || '';
        }
        
        if (!incomingMessage) {
            await sendResponse(fromNumber, 'Please send a message or voice note to place your order! ??', session.preferVoice);
            return res.status(200).send('Empty message handled');
        }
        
        // Process voice commands into standard commands
        if (isVoiceMessage) {
            incomingMessage = processVoiceCommand(incomingMessage);
        }
        
        console.log(`Processing command: "${incomingMessage}" from ${fromNumber}`);
        
        let responseMessage = '';
        
        // Handle different commands (same logic as before but with voice-friendly responses)
        if (incomingMessage.includes('hello') || incomingMessage.includes('hi') || incomingMessage === 'start') {
            responseMessage = `?? *Welcome to Delicious Bites Restaurant!*

I can understand both text and voice messages! ???

?? *Available Commands:*
• Say "menu" or "show menu" - Browse our full menu
• Say "cart" or "my cart" - View your current order  
• Say "help" - Get assistance
• Say "track order [ID]" - Track your order

To order, you can say things like:
• "I want two pizzas"
• "Add chicken burger to my cart"
• "Show me the starters"

Ready to order? Say "menu" to get started! ??`;
            
        } else if (incomingMessage === 'menu') {
            responseMessage = `??? *OUR MENU*

Which category would you like to explore?

?? Say "starters" for appetizers
?? Say "mains" for main courses  
?? Say "desserts" for sweet treats
?? Say "drinks" for beverages

Or say "full menu" to see everything`;
            
        } else if (incomingMessage === 'starters') {
            responseMessage = formatMenuCategory('Starters', menu.starters);
            responseMessage += '\nTo add an item, say: "Add [item name]" or "I want [quantity] [item name]"\nExample: "Add two spring rolls"';
            
        } else if (incomingMessage === 'mains') {
            responseMessage = formatMenuCategory('Main Courses', menu.mains);
            responseMessage += '\nTo add an item, say: "Add [item name]" or "I want [quantity] [item name]"\nExample: "I want one margherita pizza"';
            
        } else if (incomingMessage === 'desserts') {
            responseMessage = formatMenuCategory('Desserts', menu.desserts);
            responseMessage += '\nTo add an item, say: "Add [item name]" or "I want [quantity] [item name]"\nExample: "Add chocolate cake"';
            
        } else if (incomingMessage === 'drinks') {
            responseMessage = formatMenuCategory('Drinks', menu.drinks);
            responseMessage += '\nTo add an item, say: "Add [item name]" or "I want [quantity] [item name]"\nExample: "I want two cokes"';
            
        } else if (incomingMessage === 'full') {
            responseMessage = formatMenuCategory('Starters', menu.starters);
            responseMessage += formatMenuCategory('Main Courses', menu.mains);
            responseMessage += formatMenuCategory('Desserts', menu.desserts);
            responseMessage += formatMenuCategory('Drinks', menu.drinks);
            responseMessage += '\nTo add an item, say the item name with quantity or use: add [item_id] [quantity]';
            
        } else if (incomingMessage.startsWith('add ')) {
            const parts = incomingMessage.split(' ');
            if (parts.length >= 3) {
                const itemId = parts[1].toUpperCase();
                const quantity = parseInt(parts[2]);
                const item = findMenuItem(itemId);
                
                if (item && quantity > 0) {
                    const existingItem = session.cart.find(cartItem => cartItem.id === item.id);
                    if (existingItem) {
                        existingItem.quantity += quantity;
                    } else {
                        session.cart.push({
                            id: item.id,
                            name: item.name,
                            price: item.price,
                            quantity: quantity
                        });
                    }
                    responseMessage = `? Added ${quantity}x ${item.name} to your cart!\n\nSay "cart" to view your order or "menu" to continue shopping.`;
                } else {
                    responseMessage = `? Sorry, I couldn't find that item or the quantity is invalid. Please try again or say "menu" to browse our options.`;
                }
            } else {
                responseMessage = `? Please specify both the item and quantity. For example, say "Add two pizzas" or "I want one burger".`;
            }
            
        } else if (incomingMessage === 'cart') {
            responseMessage = formatCart(session.cart);
            
        } else if (incomingMessage === 'clear') {
            session.cart = [];
            responseMessage = `?? Your cart has been cleared.\n\nSay "menu" to start shopping again!`;
            
        } else if (incomingMessage === 'checkout') {
            if (session.cart.length === 0) {
                responseMessage = `?? Your cart is empty! Say "menu" to browse our delicious options.`;
            } else {
                const orderId = generateOrderId();
                const total = session.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
                
                orders.set(orderId, {
                    id: orderId,
                    phoneNumber: fromNumber,
                    items: [...session.cart],
                    total: total,
                    status: 'confirmed',
                    orderTime: new Date(),
                    estimatedDelivery: new Date(Date.now() + 30 * 60 * 1000)
                });
                
                session.cart = [];
                
                responseMessage = `?? *ORDER CONFIRMED!*

Order ID: *${orderId}*
Total: *$${total.toFixed(2)}*

?? Your delicious meal will be prepared and delivered in approximately 25-30 minutes.

?? Please have $${total.toFixed(2)} ready for cash payment upon delivery.

?? Track your order by saying: "track order ${orderId}"

Thank you for choosing Delicious Bites! ????`;
            }
            
        } else if (incomingMessage.startsWith('track ')) {
            const orderId = incomingMessage.split(' ')[1]?.toUpperCase();
            const order = orders.get(orderId);
            
            if (order) {
                const currentTime = new Date();
                const orderTime = order.orderTime;
                const minutesElapsed = Math.floor((currentTime - orderTime) / (1000 * 60));
                
                let status = '';
                if (minutesElapsed < 5) {
                    status = '?? Being prepared in kitchen';
                } else if (minutesElapsed < 20) {
                    status = '????? Cooking in progress';
                } else if (minutesElapsed < 30) {
                    status = '?? Out for delivery';
                } else {
                    status = '? Delivered';
                }
                
                responseMessage = `?? *ORDER TRACKING*

Order ID: ${order.id}
Status: ${status}
Total: $${order.total.toFixed(2)}
Order Time: ${orderTime.toLocaleTimeString()}

${minutesElapsed < 30 ? `Estimated delivery: ${order.estimatedDelivery.toLocaleTimeString()}` : 'Delivered! We hope you enjoyed your meal! ??'}`;
            } else {
                responseMessage = `? Order not found. Please check your order ID and try again.`;
            }
            
        } else if (incomingMessage === 'help') {
            responseMessage = `?? *HELP & VOICE COMMANDS*

??? *Voice Orders:*
Just speak naturally! Say things like:
• "I want two pizzas"
• "Add chicken burger to my cart"
• "Show me the desserts"
• "What's in my cart?"

?? *Text Commands:*
• "menu" - Browse our menu
• "cart" - View your current order
• "checkout" - Place your order
• "clear" - Empty your cart

?? *Order Tracking:*
Say "track order [ID]" to check status

?? *Restaurant Hours:*
Monday - Sunday: 11:00 AM - 11:00 PM

?? *Contact:*
For urgent queries, call: (555) 123-4567

I understand both voice and text! ?????`;
            
        } else if (incomingMessage.includes('bye') || incomingMessage.includes('goodbye')) {
            responseMessage = `?? Thank you for visiting Delicious Bites!

We hope to serve you again soon. Have a wonderful day! ????

Send a message or voice note anytime to start a new order!`;
            
        } else {
            responseMessage = `?? I didn't quite understand that.

??? *Try saying:*
• "Show me the menu"
• "I want a pizza"
• "What's in my cart?"
• "Help"

?? *Or type:*
• "menu" - Browse our menu
• "cart" - View your order  
• "help" - Get assistance

I can understand both voice and text! ??`;
        }
        
        // Send response
        await sendResponse(fromNumber, responseMessage, session.preferVoice);
        res.status(200).send('Message processed successfully');
        
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Error processing message');
    }
});

// Function to send response (text or voice)
async function sendResponse(toNumber, message, preferVoice = false) {
    try {
        if (preferVoice && message.length < 500) { // Only generate voice for shorter messages
            try {
                const voicePath = await generateVoiceResponse(message);
                if (voicePath) {
                    // Send voice response
                    const media = [{
                        url: `${process.env.BASE_URL || 'http://localhost:3000'}/audio/${path.basename(voicePath)}`
                    }];
                    
                    await client.messages.create({
                        from: twilioWhatsAppNumber,
                        to: toNumber,
                        body: '??? Voice response:', // Short text with voice
                        media: media
                    });
                    
                    // Clean up voice file after a delay
                    setTimeout(() => {
                        fs.unlink(voicePath, (err) => {
                            if (err) console.error('Error deleting voice file:', err);
                        });
                    }, 60000); // Delete after 1 minute
                    
                    return;
                }
            } catch (voiceError) {
                console.error('Error sending voice response, falling back to text:', voiceError);
            }
        }
        
        // Send text response
        await client.messages.create({
            from: twilioWhatsAppNumber,
            to: toNumber,
            body: message
        });
        
    } catch (error) {
        console.error('Error sending response:', error);
        throw error;
    }
}

// Serve audio files
app.use('/audio', express.static(tempDir));

// Admin endpoint to view all orders
app.get('/orders', (req, res) => {
    const allOrders = Array.from(orders.values()).map(order => ({
        id: order.id,
        phoneNumber: order.phoneNumber,
        items: order.items,
        total: order.total,
        status: order.status,
        orderTime: order.orderTime,
        estimatedDelivery: order.estimatedDelivery
    }));
    
    res.json({
        totalOrders: allOrders.length,
        orders: allOrders
    });
});

// Start server
app.listen(port, () => {
    console.log(`????? Voice-Enabled Restaurant Ordering Bot is running on port ${port}`);
    console.log(`Webhook URL: http://your-domain.com/webhook`);
    console.log(`Orders admin panel: http://your-domain.com/orders`);
    console.log(`Audio files served from: http://your-domain.com/audio/`);
});
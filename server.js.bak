const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.send('WhatsApp Chatbot is running!');
});

// Webhook endpoint for incoming WhatsApp messages
app.post('/webhook', (req, res) => {
    const incomingMessage = req.body.Body.toLowerCase();
    const fromNumber = req.body.From;
    
    console.log(`Received message: "${incomingMessage}" from ${fromNumber}`);
    
    // Simple chatbot logic
    let responseMessage = '';
    
    if (incomingMessage.includes('hello') || incomingMessage.includes('hi')) {
        responseMessage = 'Hello! Welcome to our chatbot. How can I help you today?';
    } else if (incomingMessage.includes('help')) {
        responseMessage = 'I can help you with:\n• General questions\n• Product information\n• Support requests\n\nJust type your question!';
    } else if (incomingMessage.includes('bye')) {
        responseMessage = 'Thank you for chatting with us! Have a great day! ??';
    } else {
        responseMessage = 'Thanks for your message! Our team will get back to you soon. Type "help" for more options.';
    }
    
    // Send response back via Twilio
    client.messages.create({
        from: twilioWhatsAppNumber,
        to: fromNumber,
        body: responseMessage
    })
    .then(message => {
        console.log(`Message sent: ${message.sid}`);
        res.status(200).send('Message sent successfully');
    })
    .catch(error => {
        console.error('Error sending message:', error);
        res.status(500).send('Error sending message');
    });
});

// Start server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
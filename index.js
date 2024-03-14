const path = require('path');  
const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const AWS = require('aws-sdk');
const fs = require('fs');
require('dotenv').config();


const app = express(); 
const PORT = 3000;

app.use(function(req, res, next) {
    if (req.originalUrl.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css');
    }
    next();
});


app.use(express.static('public')); 

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN
  });

// --- Constants for Ticketmaster & Weather Mashup ---
const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// --- Constants for Spotify & YouTube Mashup ---
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN; 
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID; 
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET; 
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY; 

const s3 = new AWS.S3();

const BUCKET_NAME = 'senakento';
const COUNTER_KEY = 'text.json';

async function getPageCount() {
    try {
        const data = await s3.getObject({
            Bucket: BUCKET_NAME,
            Key: COUNTER_KEY
        }).promise();

        return parseInt(data.Body.toString('utf-8')) || 0;
    } catch (error) {
        console.error("Error fetching counter:", error);
        return 0;
    }
}

async function incrementPageCount() {
    const currentCount = await getPageCount();
    const newCount = currentCount + 1;

    await s3.putObject({
        Bucket: BUCKET_NAME,
        Key: COUNTER_KEY,
        Body: newCount.toString()
    }).promise();

    return newCount;
}


async function fetchConcertDetails() {
    const response = await axios.get('https://app.ticketmaster.com/discovery/v2/events.json', {
        params: {
            apikey: TICKETMASTER_API_KEY,
            keyword: 'RADWIMPS',
            size: 3
        }
    });

    return response.data._embedded.events;
}

async function fetchWeather(city) {
    const response = await axios.get(`http://api.weatherapi.com/v1/current.json`, {
        params: {
            key: WEATHER_API_KEY,
            q: city
        }
    });

    return {
        temperature: `${response.data.current.temp_c}°C`,
        weather: response.data.current.condition.text,
        icon: "https:" + response.data.current.condition.icon 
    };
    
}

async function fetchForecast(city, days) {
    const response = await axios.get(`http://api.weatherapi.com/v1/forecast.json`, {
        params: {
            key: WEATHER_API_KEY,
            q: city,
            days: days
        }
    });

    return response.data.forecast.forecastday.map(day => ({
        date: day.date,
        temperature: `${day.day.avgtemp_c}°C`,
        weather: day.day.condition.text
    }));
}

async function getSpotifyAccessToken() {
    const authString = 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
    const response = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=refresh_token&refresh_token=' + SPOTIFY_REFRESH_TOKEN, {
        headers: {
            'Authorization': authString,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    return response.data.access_token;
}

async function searchSpotifyTracks(artistName, accessToken) {
    const response = await axios.get('https://api.spotify.com/v1/search', {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
        params: {
            q: artistName,
            type: 'track',
            limit: 6
        }
    });

    return response.data.tracks.items;
}

async function fetchRecommendedTracks(accessToken) {
    const response = await axios.get('https://api.spotify.com/v1/recommendations?seed_artists={1EowJ1WwkMzkCkRomFhui7}', {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });
    return response.data.tracks; 
}


function removeDuplicates(tracks) {
    const uniqueTracks = [];
    const seenTrackNames = new Set();

    for (let track of tracks) {
        if (!seenTrackNames.has(track.name)) {
            seenTrackNames.add(track.name);
            uniqueTracks.push(track);
        }
    }

    return uniqueTracks;
}



async function searchYouTubeVideos(trackName) {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
            part: 'snippet',
            maxResults: 1,
            q: trackName,
            key: YOUTUBE_API_KEY
        }
    });
    if (response.data.items.length > 0) {
        return response.data.items[0].id.videoId;
    }

    return null;
}


app.get('/', async (req, res) => {
    try {
        const pageVisits = await incrementPageCount();
        let htmlContent = fs.readFileSync(path.join(__dirname, 'public/html/index.html'), 'utf8');
        htmlContent = htmlContent.replace("<!-- PAGE_VISITS_PLACEHOLDER -->", `Page Visits: ${pageVisits}`);
        res.send(htmlContent);
    } catch (error) {
        res.status(500).send('Internal Server Error');
        console.error(error);
    }
});


app.get('/concert-and-weather-data', async (req, res) => {
    try {
        const events = await fetchConcertDetails();
        const weatherInfoList = [];

        for (let event of events) {
            const country = event._embedded.venues[0].country.name; 
            const cityName = `${event._embedded.venues[0].city.name}, ${country}`;
            const weatherInfo = await fetchWeather(cityName);
            weatherInfoList.push({
                eventName: event.name,
                city: cityName,
                weatherInfo: weatherInfo
            });
        }

        res.json(weatherInfoList);
    } catch (error) {
        res.status(500).send('Internal Server Error');
        console.error(error);
    }
});

app.get('/script.js', (req, res) => {
    const scriptContent = `
    window.onload = async function() {
        try {
            const response = await fetch('/concert-and-weather-data');
            const data = await response.json();

            data.forEach(item => {
                const widgetCode = generateWeatherWidget(item.city);
                document.getElementById('widgetContainer').innerHTML += widgetCode;
            });
        } catch (error) {
            console.error("Error fetching data:", error);
        }
    }

    function generateWeatherWidget(cityName) {
        // ここでウィジェットの埋め込みコードを動的に生成
        return \`
            <div class="widget">\${cityName}'s weather widget here...</div>
        \`;
    }
    `;
    res.type('.en');
    res.send(scriptContent);
});



app.get('/data', async (req, res) => {
    let output = "Concert and Weather Information:\n\n";

    try {
        const events = await fetchConcertDetails();
        for (let event of events) {
            const country = event._embedded.venues[0].country.name; 
            const cityName = `${event._embedded.venues[0].city.name}, ${country}`;  
            const eventDate = new Date(event.dates.start.localDate);
            const currentDate = new Date();
            const daysUntilEvent = Math.ceil((eventDate - currentDate) / (1000 * 60 * 60 * 24));

            output += `Name: ${event.name}\n`;
            output += `Date: ${event.dates.start.localDate}\n`;
            output += `Venue: ${event._embedded.venues[0].name}\n`;
            output += `City: ${cityName}\n`;

            if (daysUntilEvent <= 7) {
                const forecasts = await fetchForecast(cityName, daysUntilEvent);
                forecasts.forEach(forecast => {
                    output += `Forecast Date: ${forecast.date}\n`;
                    output += `Temperature: ${forecast.temperature}\n`;
                    output += `Weather: ${forecast.weather}\n`;
                    output += '------\n';
                });
            } else {
                const weatherInfo = await fetchWeather(cityName);
                output += `Temperature: ${weatherInfo.temperature}\n`;
                output += `Weather: ${weatherInfo.weather}<img src="${weatherInfo.icon}" alt="Weather Icon">\n`;
                output += '------\n';
            }
        }
    
        const accessToken = await getSpotifyAccessToken();
        const tracks = await searchSpotifyTracks('RADWIMPS', accessToken);
        const uniqueTracks = removeDuplicates(tracks);

        output += "\nMusic Recommendations:\n\n";
        for (let track of uniqueTracks) {
            const videoId = await searchYouTubeVideos(`RADWIMPS ${track.name}`);
            output += `Track Name: ${track.name}\n`;
            output += `Spotify Link: ${track.external_urls.spotify}\n`;
            if (videoId) {
                output += `YouTube Link: https://www.youtube.com/watch?v=${videoId}\n`;
            }
            output += '------\n';
        }

        res.send(output);


    } catch (error) {
        res.status(500).send('Internal Server Error');
        console.error(error);
    }
});




app.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);
});
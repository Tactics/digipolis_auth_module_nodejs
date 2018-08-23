'use strict';
const uuid = require('uuid');

module.exports = {
  oauthHost: 'https://api-oauth2-o.antwerpen.be',
  apiHost: 'https://api-gw-o.antwerpen.be',
  domain: 'http://localhost:8000',
  auth: {
    clientId: uuid.v4(),
    clientSecret: uuid.v4()
  },
  refresh: false
};

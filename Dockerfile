FROM node:10
# Create app directory
WORKDIR /usr/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install
RUN sudo apt-get update
RUN sudo apt-get install pigpio

# If you are building your code for production
# RUN npm ci --only=production

# Bundle app source
COPY . .
EXPOSE 80
EXPOSE 9000
CMD [ "node", "homecontrol.js" ]

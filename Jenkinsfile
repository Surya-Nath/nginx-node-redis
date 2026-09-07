pipeline {
  agent any
  environment {
    AWS_REGION  = 'ap-south-1'
    AWS_ACCOUNT = '413816840602'
    REGISTRY    = "413816840602.dkr.ecr.ap-south-1.amazonaws.com"
  }
  stages {
    stage('Checkout') {
      steps { checkout scm }
    }
    stage('ECR login') {
      steps {
        withCredentials([usernamePassword(
          credentialsId: 'aws-ecr',
          usernameVariable: 'AWS_ACCESS_KEY_ID',
          passwordVariable: 'AWS_SECRET_ACCESS_KEY'
        )]) {
          sh '''
            aws ecr get-login-password --region "$AWS_REGION" \
              | docker login --username AWS --password-stdin "$REGISTRY"
          '''
        }
      }
    }
    stage('Build and push web') {
      steps {
        sh '''
          docker build -t $REGISTRY/week1-web:$GIT_COMMIT -t $REGISTRY/week1-web:latest ./web
          docker push $REGISTRY/week1-web:$GIT_COMMIT
          docker push $REGISTRY/week1-web:latest
        '''
      }
    }
    stage('Build and push nginx') {
      steps {
        sh '''
          docker build -t $REGISTRY/week1-nginx:$GIT_COMMIT -t $REGISTRY/week1-nginx:latest ./nginx
          docker push $REGISTRY/week1-nginx:$GIT_COMMIT
          docker push $REGISTRY/week1-nginx:latest
        '''
      }
    }
  }
}
